const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { collectCandidates } = require('@/ingest/pipeline/collectCandidates');

function buildSource(sourceKey, overrides = {}) {
  return {
    sourceKey,
    name: sourceKey,
    feedUrl: `https://${sourceKey}.example/feed.xml`,
    homepageUrl: `https://${sourceKey}.example`,
    feedType: 'rss',
    contentMode: 'summary',
    licenseCode: 'link-only',
    dailyLimit: 2,
    trustScore: 18,
    enabled: true,
    ...overrides,
  };
}

function buildEntry(overrides = {}) {
  return {
    externalId: 'entry-1',
    url: 'https://source-a.example/post/?utm_source=feed',
    title: 'New AI agent model',
    summary: 'An LLM inference release',
    publishedAt: '2026-07-24T01:00:00.000Z',
    author: 'Research Team',
    raw: {
      id: 'entry-1',
      link: 'https://source-a.example/post/?utm_source=feed',
    },
    ...overrides,
  };
}

function createRepositoryDouble() {
  const calls = [];
  return {
    calls,
    async syncSources(sources) {
      calls.push({ method: 'syncSources', sources });
      return new Map(sources.map((source, index) => [source.sourceKey, { id: index + 1, sourceKey: source.sourceKey }]));
    },
    async createRun(input) {
      calls.push({ method: 'createRun', input });
      return 77;
    },
    async upsertCandidates(sourceId, runId, candidates) {
      calls.push({ method: 'upsertCandidates', sourceId, runId, candidates });
      return { inserted: candidates.length, duplicates: 0 };
    },
    async finishRun(runId, input) {
      calls.push({ method: 'finishRun', runId, input });
    },
  };
}

test('collectCandidates isolates failed sources and persists normalized eligible entries', async () => {
  const repository = createRepositoryDouble();
  const sources = [buildSource('source-a'), buildSource('source-b')];
  const collector = async (source) => {
    if (source.sourceKey === 'source-b') throw new Error('HTTP 503');
    return [
      buildEntry(),
      buildEntry({
        externalId: 'old',
        url: 'https://source-a.example/old',
        publishedAt: '2026-05-01T01:00:00.000Z',
      }),
    ];
  };

  const result = await collectCandidates({
    sources,
    collector,
    repository,
    days: 30,
    limit: 100,
    now: new Date('2026-07-24T08:00:00.000Z'),
  });

  assert.deepEqual(result, {
    runId: 77,
    sourcesAttempted: 2,
    sourcesSucceeded: 1,
    sourcesFailed: 1,
    fetched: 2,
    eligible: 1,
    inserted: 1,
    duplicates: 0,
    sourceErrors: [{ sourceKey: 'source-b', message: 'HTTP 503' }],
  });

  const upsert = repository.calls.find((call) => call.method === 'upsertCandidates');
  assert.equal(upsert.sourceId, 1);
  assert.equal(upsert.runId, 77);
  assert.equal(upsert.candidates.length, 1);
  assert.equal(upsert.candidates[0].canonicalUrl, 'https://source-a.example/post');
  assert.match(upsert.candidates[0].contentHash, /^[a-f0-9]{64}$/);
  assert.ok(upsert.candidates[0].score >= 70);

  const finish = repository.calls.find((call) => call.method === 'finishRun');
  assert.equal(finish.input.status, 'succeeded');
  assert.deepEqual(finish.input.stats, result);
});

test('collectCandidates applies one global score order and limit across sources', async () => {
  const repository = createRepositoryDouble();
  const sources = [buildSource('source-a'), buildSource('source-b')];
  const collector = async (source) => [
    buildEntry({
      externalId: `${source.sourceKey}-entry`,
      url: `https://${source.sourceKey}.example/post`,
      title: source.sourceKey === 'source-b' ? 'AI LLM agent model inference transformer' : 'AI update',
    }),
  ];

  await collectCandidates({
    sources,
    collector,
    repository,
    days: 30,
    limit: 1,
    now: new Date('2026-07-24T08:00:00.000Z'),
  });

  const upserts = repository.calls.filter((call) => call.method === 'upsertCandidates');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].candidates[0].externalId, 'source-b-entry');
});

test('collectCandidates marks the run failed when every source fails', async () => {
  const repository = createRepositoryDouble();

  await assert.rejects(
    () =>
      collectCandidates({
        sources: [buildSource('source-a')],
        collector: async () => {
          throw new Error('DNS unavailable');
        },
        repository,
        now: new Date('2026-07-24T08:00:00.000Z'),
      }),
    /All feed sources failed/,
  );

  const finish = repository.calls.find((call) => call.method === 'finishRun');
  assert.equal(finish.input.status, 'failed');
  assert.match(finish.input.errorMessage, /All feed sources failed/);
});
