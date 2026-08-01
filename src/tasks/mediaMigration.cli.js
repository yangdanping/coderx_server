require('module-alias/register');

const KNOWN_COMMANDS = new Set(['inventory', 'backfill-local', 'migrate-r2', 'reconcile']);
const BOOLEAN_OPTIONS = new Set(['--dry-run', '--apply', '--repair']);
const VALUE_OPTIONS = new Set(['--article-id', '--after-file-id', '--limit', '--concurrency', '--pending-older-than-minutes']);

function positiveInteger(value, optionName, { max } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${optionName} must be a positive integer`);
  if (max != null && parsed > max) throw new Error(`${optionName} must be between 1 and ${max}`);
  return parsed;
}

function nonNegativeInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${optionName} must be a non-negative integer`);
  return parsed;
}

function parseMediaMigrationArgs(argv) {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...tokens] = normalizedArgv;
  if (!KNOWN_COMMANDS.has(command)) throw new Error(`Unknown command: ${command || '(missing)'}`);
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (BOOLEAN_OPTIONS.has(token)) {
      const key = token === '--dry-run' ? 'dryRun' : token.slice(2);
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`Unknown option: ${token}`);
    const value = tokens[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for option: ${token}`);
    index += 1;
    if (token === '--article-id') options.articleId = positiveInteger(value, token);
    else if (token === '--after-file-id') options.afterFileId = nonNegativeInteger(value, token);
    else if (token === '--limit') options.limit = positiveInteger(value, token);
    else if (token === '--concurrency') options.concurrency = positiveInteger(value, token, { max: 10 });
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

async function runMediaMigrationCli(argv, { actions, write = process.stdout.write.bind(process.stdout) }) {
  const { command, options } = parseMediaMigrationArgs(argv);
  let result;
  try {
    if (command === 'inventory') result = await actions.inventory(options);
    else if (command === 'backfill-local') result = await actions.backfillLocal({ ...options, dryRun: options.apply !== true });
    else if (command === 'migrate-r2') result = await actions.migrateR2({ ...options, dryRun: options.apply !== true });
    else if (command === 'reconcile') result = await actions.reconcile({ ...options, repair: options.repair === true });
    write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await actions.close?.();
  }
}

function createDefaultActions() {
  process.env.CONFIG_QUIET = 'true';
  const path = require('node:path');
  const config = require('@/app/config');
  const database = require('@/app/database');
  const { IMG_PATH, VIDEO_PATH } = require('@/constants/filePaths');
  const { createMediaObjectService } = require('@/service/mediaObject.service');
  const { createMediaPromotionService } = require('@/service/mediaPromotion.service');
  const { createR2Client, createR2MediaStore } = require('@/storage/r2MediaStore');
  const { backfillLocalMediaObjects } = require('@/tasks/backfillLocalMediaObjects');
  const { createMediaCatalog } = require('@/tasks/mediaCatalog');
  const { inventoryMedia } = require('@/tasks/inventoryMedia');
  const { migrateMediaToR2 } = require('@/tasks/migrateMediaToR2');
  const { reconcileR2Media } = require('@/tasks/reconcileR2Media');
  const catalog = createMediaCatalog({
    database,
    imageRoot: path.resolve(IMG_PATH),
    videoRoot: path.resolve(VIDEO_PATH),
  });
  const mediaObjectService = createMediaObjectService({ database, hardLimitBytes: Number(config.R2_HARD_LIMIT_BYTES) });
  let r2Store;
  let mediaPromotionService;

  function getR2Store() {
    if (!r2Store) {
      r2Store = createR2MediaStore({
        client: createR2Client({
          accountId: config.R2_ACCOUNT_ID,
          accessKeyId: config.R2_ACCESS_KEY_ID,
          secretAccessKey: config.R2_SECRET_ACCESS_KEY,
        }),
        bucket: config.R2_BUCKET,
        publicBaseUrl: config.MEDIA_CDN_BASE_URL,
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

  function common(options) {
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
        writeMode: config.MEDIA_WRITE_MODE,
        writePaused: config.MEDIA_R2_WRITE_PAUSED,
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
    close() {
      return database.end();
    },
  };
}

async function main() {
  try {
    await runMediaMigrationCli(process.argv.slice(2), { actions: createDefaultActions() });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: String(error?.message || error).slice(0, 1_000) })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  createDefaultActions,
  parseMediaMigrationArgs,
  runMediaMigrationCli,
};
