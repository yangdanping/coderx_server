import { join, resolve } from 'node:path';
import { DEFAULT_R2_HARD_LIMIT_BYTES, MEDIA_WRITE_MODE } from '../constants/mediaStorage.js';
import { backfillLocalMediaObjects } from './backfillLocalMediaObjects.js';
import { inventoryMedia } from './inventoryMedia.js';
import { createMediaCatalog, type MediaBatch } from './mediaCatalog.js';
import { MAX_CONCURRENCY, migrateMediaToR2 } from './migrateMediaToR2.js';
import { reconcileR2Media } from './reconcileR2Media.js';

interface MigrationArgs extends MediaBatch {
  apply?: boolean;
  dryRun?: boolean;
  repair?: boolean;
  concurrency?: number;
  pendingOlderThanMinutes?: number;
}

export interface MediaMigrationActions {
  inventory(options: MigrationArgs): Promise<unknown>;
  backfillLocal(options: MigrationArgs & { dryRun: boolean }): Promise<unknown>;
  migrateR2(options: MigrationArgs & { dryRun: boolean }): Promise<unknown>;
  reconcile(options: MigrationArgs & { repair: boolean }): Promise<unknown>;
  close?(): void | Promise<void>;
}

const booleanOptions = new Map<string, 'dryRun' | 'apply' | 'repair'>([
  ['--dry-run', 'dryRun'],
  ['--apply', 'apply'],
  ['--repair', 'repair'],
]);
const VALUE_OPTIONS = new Set(['--article-id', '--after-file-id', '--limit', '--concurrency', '--pending-older-than-minutes']);

function positiveInteger(value: string, optionName: string, max?: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${optionName} must be a positive integer`);
  if (max != null && parsed > max) throw new Error(`${optionName} must be between 1 and ${max}`);
  return parsed;
}

function nonNegativeInteger(value: string, optionName: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${optionName} must be a non-negative integer`);
  return parsed;
}

export function parseMediaMigrationArgs(argv: readonly string[]) {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...tokens] = normalizedArgv;
  if (command !== 'inventory' && command !== 'backfill-local' && command !== 'migrate-r2' && command !== 'reconcile') {
    throw new Error(`Unknown command: ${command || '(missing)'}`);
  }
  const options: MigrationArgs = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const flag = booleanOptions.get(token);
    if (flag) {
      options[flag] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`Unknown option: ${token}`);
    const value = tokens[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for option: ${token}`);
    index += 1;
    if (token === '--article-id') options.articleId = positiveInteger(value, token);
    else if (token === '--after-file-id') options.afterFileId = nonNegativeInteger(value, token);
    else if (token === '--limit') options.limit = positiveInteger(value, token);
    else if (token === '--concurrency') options.concurrency = positiveInteger(value, token, MAX_CONCURRENCY);
    else if (token === '--pending-older-than-minutes') options.pendingOlderThanMinutes = positiveInteger(value, token);
    else throw new Error(`Unknown option: ${token}`);
  }

  if (options.apply && options.dryRun) throw new Error('--apply and --dry-run are mutually exclusive');
  if (options.apply && !['backfill-local', 'migrate-r2'].includes(command)) throw new Error('--apply is only valid with backfill-local or migrate-r2');
  if (options.dryRun && !['backfill-local', 'migrate-r2'].includes(command)) throw new Error('--dry-run is only valid with backfill-local or migrate-r2');
  if (options.repair && command !== 'reconcile') throw new Error('--repair is only valid with reconcile');
  if (options.concurrency != null && command !== 'migrate-r2') throw new Error('--concurrency is only valid with migrate-r2');
  if (options.pendingOlderThanMinutes != null && command !== 'reconcile') {
    throw new Error('--pending-older-than-minutes is only valid with reconcile');
  }
  return { command, options };
}

export async function runMediaMigrationCli(
  argv: readonly string[],
  { actions, write = (data) => process.stdout.write(data) }: { actions?: MediaMigrationActions; write?: (data: string) => void } = {},
) {
  const { command, options } = parseMediaMigrationArgs(argv);
  const selectedActions = actions ?? (await createDefaultActions());
  let result: unknown;
  try {
    if (command === 'inventory') result = await selectedActions.inventory(options);
    else if (command === 'backfill-local') result = await selectedActions.backfillLocal({ ...options, dryRun: options.apply !== true });
    else if (command === 'migrate-r2') result = await selectedActions.migrateR2({ ...options, dryRun: options.apply !== true });
    else if (command === 'reconcile') result = await selectedActions.reconcile({ ...options, repair: options.repair === true });
    write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await selectedActions.close?.();
  }
}

export async function createDefaultActions(): Promise<MediaMigrationActions> {
  process.env.CONFIG_QUIET = 'true';
  const { loadEnvironment } = await import('../app/loadEnvironment.js');
  loadEnvironment();
  const [
    { createPgClient },
    {
      default: { sqlLogger },
    },
    { createMediaObjectService },
    { createMediaPromotionService },
    { createR2Client, createR2MediaStore },
  ] = await Promise.all([
    import('../app/database/pg.factory.js'),
    import('../app/logger.js'),
    import('../service/mediaObject.service.js'),
    import('../service/mediaPromotion.service.js'),
    import('../storage/r2MediaStore.js'),
  ]);
  const mediaRoot = resolve(process.env.MEDIA_ROOT || 'public');
  const hardLimitBytes = Number(process.env.R2_HARD_LIMIT_BYTES || DEFAULT_R2_HARD_LIMIT_BYTES);
  const database = createPgClient(process.env, sqlLogger);
  const catalog = createMediaCatalog({ database, imageRoot: join(mediaRoot, 'img'), videoRoot: join(mediaRoot, 'video') });
  let mediaObjectService: ReturnType<typeof createMediaObjectService>;
  try {
    mediaObjectService = createMediaObjectService({ database, hardLimitBytes });
  } catch (error) {
    await database.end();
    throw error;
  }
  let r2Client: ReturnType<typeof createR2Client> | undefined;
  let r2Store: ReturnType<typeof createR2MediaStore> | undefined;
  let mediaPromotionService: ReturnType<typeof createMediaPromotionService> | undefined;

  function getR2Store() {
    if (!r2Store) {
      r2Client = createR2Client({
        accountId: process.env.R2_ACCOUNT_ID || '',
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      });
      r2Store = createR2MediaStore({
        client: r2Client,
        bucket: process.env.R2_BUCKET || 'coderx-media-public',
        publicBaseUrl: process.env.MEDIA_CDN_BASE_URL || 'https://media.ydp321.asia',
      });
    }
    return r2Store;
  }

  function getPromotionService() {
    if (!mediaPromotionService) {
      mediaPromotionService = createMediaPromotionService({ mediaObjectService, r2Store: getR2Store() });
    }
    return mediaPromotionService;
  }

  function common(options: MigrationArgs) {
    return {
      articleId: options.articleId,
      afterFileId: options.afterFileId,
      limit: options.limit,
    };
  }

  return {
    inventory(options) {
      return inventoryMedia({ catalog, database, ...common(options) });
    },
    backfillLocal(options) {
      return backfillLocalMediaObjects({ catalog, database, dryRun: options.dryRun, ...common(options) });
    },
    migrateR2(options) {
      return migrateMediaToR2({
        catalog,
        mediaPromotionService: getPromotionService(),
        dryRun: options.dryRun,
        concurrency: options.concurrency,
        writeMode: process.env.MEDIA_WRITE_MODE || MEDIA_WRITE_MODE.LOCAL,
        writePaused: process.env.MEDIA_R2_WRITE_PAUSED,
        ...common(options),
      });
    },
    reconcile(options) {
      return reconcileR2Media({
        catalog,
        database,
        mediaObjectService,
        r2Store: getR2Store(),
        repair: options.repair,
        pendingOlderThanMs: options.pendingOlderThanMinutes == null ? undefined : options.pendingOlderThanMinutes * 60_000,
        ...common(options),
      });
    },
    async close() {
      try {
        r2Client?.destroy();
      } finally {
        await database.end();
      }
    },
  };
}

async function main() {
  try {
    await runMediaMigrationCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: String((error instanceof Error && error.message) || error).slice(0, 1_000) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
