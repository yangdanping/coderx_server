require('module-alias/register');

const fs = require('node:fs');
const path = require('node:path');

const KNOWN_COMMANDS = new Set(['collect', 'enrich', 'list', 'approve', 'publish', 'backfill-rich', 'run']);
const KNOWN_STATUSES = new Set(['pending', 'enriched', 'approved', 'rejected', 'published', 'failed']);

function positiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function csvValues(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCliArgs(argv) {
  const [command, ...tokens] = argv;
  if (!KNOWN_COMMANDS.has(command)) throw new Error(`Unknown command: ${command || '(missing)'}`);

  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      options.json = true;
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
      options.statuses = csvValues(value);
      if (options.statuses.length === 0 || options.statuses.some((status) => !KNOWN_STATUSES.has(status))) {
        throw new Error('--status contains an unknown candidate status');
      }
    } else if (token === '--ids') {
      options.ids = csvValues(value).map((id) => positiveInteger(id, '--ids'));
    } else if (token === '--output') {
      options.output = value;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }

  if (command === 'backfill-rich') {
    if (!options.ids?.length) throw new Error('backfill-rich requires --ids');
    if (options.ids.length > 5) throw new Error('backfill-rich accepts at most 5 IDs');
    if (new Set(options.ids).size !== options.ids.length) throw new Error('backfill-rich does not accept duplicate IDs');
  }

  return { command, options };
}

function renderList(rows) {
  const header = ['id', 'status', 'score', 'source', 'title'].join('\t');
  const lines = rows.map((row) => [row.id, row.status, row.score ?? '', row.sourceName || '', row.titleZh || row.titleOriginal || ''].join('\t'));
  return [header, ...lines].join('\n');
}

function writeJsonFile(filePath, content) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

async function runCli(argv, { actions, config, write = process.stdout.write.bind(process.stdout), writeFile = writeJsonFile }) {
  const { command, options } = parseCliArgs(argv);
  if (options.output && (command !== 'list' || !options.json)) {
    throw new Error('--output requires list --json');
  }
  let result;

  if (command === 'run') {
    const collect = await actions.collect(options);
    const enrich = await actions.enrich(options);
    const publish = config.autoPublish ? await actions.publish(options) : { skipped: true, reason: 'INGEST_AUTO_PUBLISH is disabled' };
    result = { collect, enrich, publish };
  } else {
    const action = actions[command];
    if (typeof action !== 'function') throw new Error(`Action is unavailable: ${command}`);
    result = await action(options);
  }

  const output = command === 'list' && !options.json ? `${renderList(result)}\n` : `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, output);
  } else {
    write(output);
  }
  return result;
}

function createDefaultActions(config) {
  const sources = require('@/ingest/config/sources');
  const { collectFeed } = require('@/ingest/collectors/rssCollector');
  const { createIngestDatabase } = require('@/ingest/database');
  const { createOllamaEnricher } = require('@/ingest/enrichment/createOllamaEnricher');
  const { createRichArticleEnricher } = require('@/ingest/enrichment/createRichArticleEnricher');
  const { safeRemoteFetch } = require('@/ingest/extraction/safeRemoteFetch');
  const { extractArticlePage } = require('@/ingest/extraction/extractArticlePage');
  const { IMG_PATH } = require('@/constants/filePaths');
  const { localizeArticleImages } = require('@/ingest/media/localizeArticleImages');
  const { backfillRichArticles } = require('@/ingest/pipeline/backfillRichArticles');
  const { collectCandidates } = require('@/ingest/pipeline/collectCandidates');
  const { enrichCandidates } = require('@/ingest/pipeline/enrichCandidates');
  const { publishCandidates } = require('@/ingest/pipeline/publishCandidates');
  const { runWithLock } = require('@/ingest/pipeline/runWithLock');
  const { createIngestRepository } = require('@/ingest/repositories/ingestRepository');
  const { createRichArticleRepository } = require('@/ingest/repositories/richArticleRepository');
  const database = createIngestDatabase(config.database);
  const repository = createIngestRepository(database);
  const richRepository = createRichArticleRepository(database);

  return {
    async collect(options) {
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
    async enrich(options) {
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
    async list(options) {
      return await repository.listCandidates({
        statuses: options.statuses,
        limit: options.limit || 60,
      });
    },
    async approve(options) {
      return await repository.approveCandidates({
        ids: options.ids,
        limit: options.limit || config.limit,
      });
    },
    async publish(options) {
      return await publishCandidates({
        repository,
        authorName: config.authorName,
        tagName: config.tagName,
        limit: options.limit || config.limit,
      });
    },
    async 'backfill-rich'(options) {
      const ids = options.ids.slice(0, options.limit || options.ids.length);
      const enricher = createRichArticleEnricher({
        baseURL: config.ollamaBaseURL,
        model: config.ollamaModel,
      });
      return await backfillRichArticles({
        repository: richRepository,
        ids,
        authorIds: config.authorIds,
        days: options.days || 30,
        outputDir: path.resolve(IMG_PATH),
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
      });
    },
    async close() {
      await database.end();
    },
  };
}

async function main() {
  const { loadRuntimeConfig, loadRuntimeEnvironment } = require('@/ingest/config/runtime');
  loadRuntimeEnvironment();
  const config = loadRuntimeConfig();
  const actions = createDefaultActions(config);

  try {
    await runCli(process.argv.slice(2), { actions, config });
  } finally {
    await actions.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createDefaultActions,
  parseCliArgs,
  runCli,
};
