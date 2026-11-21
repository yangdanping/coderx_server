import type { DatabaseAdapter } from '../app/database/database.types.js';
import { loadRuntimeConfig, loadRuntimeEnvironment } from './config/runtime.js';
import type { Candidate, CandidateStatus } from './ingest.types.js';
import type { MediaSynchronization } from './pipeline/backfillRichArticles.js';
import sources from './config/sources.js';
import { collectFeed } from './collectors/rssCollector.js';
import { createIngestDatabase } from './database.js';
import { createOllamaEnricher } from './enrichment/createOllamaEnricher.js';
import { createRichArticleEnricher } from './enrichment/createRichArticleEnricher.js';
import { safeRemoteFetch } from './extraction/safeRemoteFetch.js';
import { extractArticlePage } from './extraction/extractArticlePage.js';
import { localizeArticleImages } from './media/localizeArticleImages.js';
import { backfillRawArticles } from './pipeline/backfillRawArticles.js';
import { backfillRichArticles } from './pipeline/backfillRichArticles.js';
import { collectCandidates } from './pipeline/collectCandidates.js';
import { enrichCandidates } from './pipeline/enrichCandidates.js';
import { publishCandidates } from './pipeline/publishCandidates.js';
import { purgePlaceholderArticles } from './pipeline/purgePlaceholderArticles.js';
import { runWithLock } from './pipeline/runWithLock.js';
import { createIngestRepository } from './repositories/ingestRepository.js';
import { createRichArticleRepository } from './repositories/richArticleRepository.js';
import { createIngestMediaService } from './media/ingestMediaService.js';
import { createR2Client, createR2MediaStore } from '../storage/r2MediaStore.js';
import fs from 'node:fs';
import path from 'node:path';

const COMMANDS = ['collect', 'enrich', 'list', 'approve', 'publish', 'backfill-rich', 'backfill-raw', 'retry-media', 'purge-placeholders', 'run'] as const;
const KNOWN_COMMANDS: ReadonlySet<string> = new Set(COMMANDS);
const KNOWN_STATUSES: ReadonlySet<string> = new Set<CandidateStatus>(['pending', 'enriched', 'approved', 'rejected', 'published', 'failed']);

type Command = (typeof COMMANDS)[number];
type ActionCommand = Exclude<Command, 'run' | 'list'>;
type ListRow = Pick<Candidate, 'id' | 'status' | 'score' | 'sourceName' | 'titleZh' | 'titleOriginal'>;
type RuntimeConfig = ReturnType<typeof loadRuntimeConfig>;
type Database = DatabaseAdapter & { end(): Promise<void> };

interface CliOptions {
  json?: boolean;
  apply?: boolean;
  days?: number;
  limit?: number;
  perSourceLimit?: number;
  statuses?: CandidateStatus[];
  ids?: number[];
  output?: string;
}

type CliActions = Partial<Record<ActionCommand, (options: CliOptions) => unknown>> & {
  list?(options: CliOptions): readonly ListRow[] | Promise<readonly ListRow[]>;
};
interface CliContext {
  actions: CliActions;
  config: { autoPublish?: boolean };
  write?: (output: string) => unknown;
  writeFile?: (path: string, output: string) => void | Promise<void>;
}

interface DefaultActionDependencies {
  database?: Database;
  createMediaService?(options: Parameters<typeof createIngestMediaService>[0]): {
    synchronizeArticle(payload: Parameters<ReturnType<typeof createIngestMediaService>['synchronizeArticle']>[0]): Promise<MediaSynchronization>;
  };
}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && KNOWN_COMMANDS.has(value);
}

function isStatus(value: string): value is CandidateStatus {
  return KNOWN_STATUSES.has(value);
}

function positiveInteger(value: string, optionName: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function csvValues(value: string) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCliArgs(argv: readonly string[]) {
  const [command, ...tokens] = argv;
  if (!isCommand(command)) throw new Error(`Unknown command: ${command || '(missing)'}`);

  const options: CliOptions = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--apply') {
      if (command !== 'purge-placeholders') throw new Error('--apply is only valid with purge-placeholders');
      options.apply = true;
      continue;
    }

    const value = tokens[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for option: ${token}`);
    }
    index += 1;

    if (token === '--days') {
      options.days = positiveInteger(value, '--days');
    } else if (token === '--limit') {
      options.limit = positiveInteger(value, '--limit');
    } else if (token === '--per-source-limit') {
      options.perSourceLimit = positiveInteger(value, '--per-source-limit');
    } else if (token === '--status') {
      const statuses = csvValues(value);
      if (statuses.length === 0 || !statuses.every(isStatus)) {
        throw new Error('--status contains an unknown candidate status');
      }
      options.statuses = statuses;
    } else if (token === '--ids') {
      options.ids = csvValues(value).map((id) => positiveInteger(id, '--ids'));
    } else if (token === '--output') {
      options.output = value;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }

  if (command === 'backfill-rich' || command === 'backfill-raw' || command === 'retry-media') {
    if (!options.ids?.length) throw new Error(`${command} requires --ids`);
    if (options.ids.length > 5) throw new Error(`${command} accepts at most 5 IDs`);
    if (new Set(options.ids).size !== options.ids.length) throw new Error(`${command} does not accept duplicate IDs`);
  }

  return { command, options };
}

function renderList(rows: readonly ListRow[]) {
  const header = ['id', 'status', 'score', 'source', 'title'].join('\t');
  const lines = rows.map((row) => [row.id, row.status, row.score ?? '', row.sourceName || '', row.titleZh || row.titleOriginal || ''].join('\t'));
  return [header, ...lines].join('\n');
}

function writeJsonFile(filePath: string, content: string) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

async function runCli(argv: readonly string[], { actions, config, write = (output) => process.stdout.write(output), writeFile = writeJsonFile }: CliContext) {
  const { command, options } = parseCliArgs(argv);
  if (options.output && (command !== 'list' || !options.json)) {
    throw new Error('--output requires list --json');
  }
  let result: unknown;
  let renderedList: string | undefined;

  if (command === 'run') {
    const collect = await actions.collect!(options);
    const enrich = await actions.enrich!(options);
    const publish = config.autoPublish ? await actions.publish!(options) : { skipped: true, reason: 'INGEST_AUTO_PUBLISH is disabled' };
    result = { collect, enrich, publish };
  } else if (command === 'list') {
    if (typeof actions.list !== 'function') throw new Error(`Action is unavailable: ${command}`);
    const rows = await actions.list(options);
    result = rows;
    if (!options.json) renderedList = renderList(rows);
  } else {
    const action = actions[command];
    if (typeof action !== 'function') throw new Error(`Action is unavailable: ${command}`);
    result = await action(options);
  }

  const output = `${renderedList ?? JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, output);
  } else {
    write(output);
  }
  return result;
}

function createDefaultActions(config: RuntimeConfig, dependencies: DefaultActionDependencies = {}) {
  const database = dependencies.database || createIngestDatabase(config.database);
  const repository = createIngestRepository(database);
  const richRepository = createRichArticleRepository(database);
  const mediaConfig = config.media;
  const mediaRoot = path.resolve(process.cwd(), process.env.MEDIA_ROOT || 'public');
  const imageRoot = path.join(mediaRoot, 'img');
  const videoRoot = path.join(mediaRoot, 'video');
  let store: ReturnType<typeof createR2MediaStore> | undefined;
  let client: ReturnType<typeof createR2Client> | undefined;
  function getStore() {
    client ??= createR2Client(mediaConfig);
    store ??= createR2MediaStore({ client, bucket: mediaConfig.bucket, publicBaseUrl: mediaConfig.publicBaseUrl });
    return store;
  }
  const mediaService = (dependencies.createMediaService || createIngestMediaService)({
    database,
    imageRoot: imageRoot,
    videoRoot: videoRoot,
    ...mediaConfig,
    r2Store: {
      put(payload) {
        return getStore().put(payload);
      },
      head(key) {
        return getStore().head(key);
      },
      delete(key) {
        return getStore().delete(key);
      },
    },
  });
  function assertMediaMutationsEnabled() {
    if (mediaConfig.mutationsPaused) throw new Error('Media mutations are paused');
  }

  return {
    async collect(options: CliOptions) {
      return await runWithLock(repository, () =>
        collectCandidates({
          sources,
          collector: (source) =>
            collectFeed(source, {
              timeoutMs: config.timeoutMs,
            }),
          repository,
          days: options.days || config.days,
          limit: options.limit || config.limit,
          perSourceLimit: options.perSourceLimit,
        }),
      );
    },
    async enrich(options: CliOptions) {
      const enricher = createOllamaEnricher({
        baseURL: config.ollamaBaseURL,
        model: config.ollamaModel,
      });
      return await enrichCandidates({
        repository,
        enricher,
        limit: options.limit || config.limit,
      });
    },
    async list(options: CliOptions) {
      return await repository.listCandidates({
        statuses: options.statuses,
        limit: options.limit || 60,
      });
    },
    async approve(options: CliOptions) {
      return await repository.approveCandidates({
        ids: options.ids,
        limit: options.limit || config.limit,
      });
    },
    async publish(options: CliOptions) {
      return await publishCandidates({
        repository,
        authorName: config.authorName,
        tagName: config.tagName,
        limit: options.limit || config.limit,
      });
    },
    async 'backfill-rich'(options: CliOptions) {
      assertMediaMutationsEnabled();
      const ids = (options.ids || []).slice(0, options.limit || options.ids?.length);
      const enricher = createRichArticleEnricher({
        baseURL: config.ollamaBaseURL,
        model: config.ollamaModel,
      });
      return await runWithLock(repository, () =>
        backfillRichArticles({
          repository: richRepository,
          ids,
          authorIds: config.authorIds,
          days: options.days || 30,
          outputDir: imageRoot,
          publicBaseURL: config.publicBaseURL,
          enricher,
          extractor: async (candidate) => {
            const response = await safeRemoteFetch(candidate.canonicalUrl, {
              timeoutMs: config.timeoutMs,
              maxBytes: 2 * 1024 * 1024,
            });
            return extractArticlePage({
              canonicalUrl: response.url,
              html: response.buffer.toString('utf8'),
            });
          },
          localizeImages: localizeArticleImages,
          synchronizeMedia: (payload) => mediaService.synchronizeArticle(payload),
        }),
      );
    },
    async 'backfill-raw'(options: CliOptions) {
      assertMediaMutationsEnabled();
      const ids = (options.ids || []).slice(0, options.limit || options.ids?.length);
      return await runWithLock(repository, () =>
        backfillRawArticles({
          repository: richRepository,
          ids,
          authorIds: config.authorIds,
          tagName: config.tagName,
          days: options.days || 30,
          outputDir: imageRoot,
          publicBaseURL: config.publicBaseURL,
          extractor: async (candidate) => {
            const response = await safeRemoteFetch(candidate.canonicalUrl, {
              timeoutMs: config.timeoutMs,
              maxBytes: 2 * 1024 * 1024,
            });
            return extractArticlePage({
              canonicalUrl: response.url,
              html: response.buffer.toString('utf8'),
            });
          },
          localizeImages: localizeArticleImages,
          synchronizeMedia: (payload) => mediaService.synchronizeArticle(payload),
        }),
      );
    },
    async 'retry-media'(options: CliOptions) {
      return await runWithLock(repository, async () => {
        const articles = [];
        for (const articleId of (options.ids || []).slice(0, options.limit || options.ids?.length)) {
          try {
            articles.push({ articleId, media: await mediaService.synchronizeArticle({ articleId }) });
          } catch (error) {
            articles.push({ articleId, media: { status: 'retry_required', reason: String(error instanceof Error && error.message ? error.message : error) } });
          }
        }
        return { attempted: articles.length, articles };
      });
    },
    async 'purge-placeholders'(options: CliOptions) {
      return await purgePlaceholderArticles({
        repository: richRepository,
        apply: options.apply === true,
      });
    },
    async close() {
      try {
        await database.end();
      } finally {
        client?.destroy();
      }
    },
  };
}

async function main() {
  loadRuntimeEnvironment();
  const config = loadRuntimeConfig();
  const actions = createDefaultActions(config);

  try {
    await runCli(process.argv.slice(2), { actions, config });
  } finally {
    await actions.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { createDefaultActions, parseCliArgs, runCli };
