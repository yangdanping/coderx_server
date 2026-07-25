const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createIngestRepository } = require('@/ingest/repositories/ingestRepository');
const { runWithLock } = require('@/ingest/pipeline/runWithLock');

function createDatabaseDouble(handler = async () => [[], []]) {
  const calls = [];
  return {
    calls,
    async execute(statement, params = []) {
      calls.push({ target: 'pool', statement, params });
      return handler(statement, params, calls);
    },
  };
}

function buildSource(sourceKey = 'source-a') {
  return {
    sourceKey,
    name: 'Source A',
    feedUrl: 'https://example.com/feed.xml',
    homepageUrl: 'https://example.com',
    feedType: 'rss',
    contentMode: 'summary',
    licenseCode: 'link-only',
    dailyLimit: 2,
    trustScore: 18,
    enabled: true,
  };
}

function buildCandidate(overrides = {}) {
  return {
    externalId: 'entry-1',
    canonicalUrl: 'https://example.com/entry-1',
    titleOriginal: 'AI entry',
    summaryOriginal: 'AI summary',
    authorOriginal: 'Team',
    sourcePublishedAt: '2026-07-24T01:00:00.000Z',
    contentMode: 'summary',
    licenseCode: 'link-only',
    rawPayload: { id: 'entry-1', link: 'https://example.com/entry-1' },
    contentHash: 'a'.repeat(64),
    score: 82,
    ...overrides,
  };
}

test('syncSources upserts stable source keys and returns their database ids', async () => {
  const database = createDatabaseDouble(async (statement, params) => {
    assert.match(statement, /INSERT INTO ingest_source/i);
    assert.match(statement, /ON CONFLICT \(source_key\) DO UPDATE/i);
    assert.match(statement, /RETURNING id/i);
    return [{ insertId: params[0] === 'source-a' ? 11 : 12, affectedRows: 1 }, []];
  });
  const repository = createIngestRepository(database);

  const result = await repository.syncSources([buildSource('source-a'), buildSource('source-b')]);

  assert.deepEqual(
    Array.from(result.entries()),
    [
      ['source-a', { id: 11, sourceKey: 'source-a' }],
      ['source-b', { id: 12, sourceKey: 'source-b' }],
    ],
  );
  assert.equal(database.calls.length, 2);
});

test('upsertCandidates inserts new rows and refreshes duplicates found by any unique identity', async () => {
  let insertCount = 0;
  const database = createDatabaseDouble(async (statement) => {
    if (/INSERT INTO ingest_candidate/i.test(statement)) {
      insertCount += 1;
      return [{ affectedRows: insertCount === 1 ? 1 : 0, insertId: insertCount === 1 ? 31 : 0 }, []];
    }
    if (/UPDATE ingest_candidate/i.test(statement)) {
      assert.match(statement, /canonical_url = \?/i);
      assert.match(statement, /source_id = \? AND external_id = \?/i);
      assert.match(statement, /content_hash = \?/i);
      return [{ affectedRows: 1, insertId: 0 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const repository = createIngestRepository(database);

  const result = await repository.upsertCandidates(11, 91, [
    buildCandidate(),
    buildCandidate({
      externalId: 'entry-2',
      canonicalUrl: 'https://example.com/entry-2',
      contentHash: 'b'.repeat(64),
    }),
  ]);

  assert.deepEqual(result, { inserted: 1, duplicates: 1 });
  assert.equal(database.calls.filter((call) => /INSERT INTO ingest_candidate/i.test(call.statement)).length, 2);
  assert.equal(database.calls.filter((call) => /UPDATE ingest_candidate/i.test(call.statement)).length, 1);
});

test('withAdvisoryLock skips work when another worker owns the lock and always releases the connection', async () => {
  let callbackCalled = false;
  const connectionCalls = [];
  const connection = {
    async execute(statement, params) {
      connectionCalls.push({ statement, params });
      if (/pg_try_advisory_lock/i.test(statement)) return [[{ acquired: false }], []];
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    release() {
      connectionCalls.push({ op: 'release' });
    },
  };
  const repository = createIngestRepository({
    async getConnection() {
      return connection;
    },
  });

  const result = await runWithLock(repository, async () => {
    callbackCalled = true;
  });

  assert.deepEqual(result, { skipped: true });
  assert.equal(callbackCalled, false);
  assert.deepEqual(connectionCalls.at(-1), { op: 'release' });
});

test('withAdvisoryLock unlocks and releases after successful work', async () => {
  const connectionCalls = [];
  const connection = {
    async execute(statement, params) {
      connectionCalls.push({ statement, params });
      if (/pg_try_advisory_lock/i.test(statement)) return [[{ acquired: true }], []];
      if (/pg_advisory_unlock/i.test(statement)) return [[{ released: true }], []];
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    release() {
      connectionCalls.push({ op: 'release' });
    },
  };
  const repository = createIngestRepository({
    async getConnection() {
      return connection;
    },
  });

  const result = await runWithLock(repository, async () => ({ collected: 4 }));

  assert.deepEqual(result, { collected: 4 });
  assert.match(connectionCalls[0].statement, /pg_try_advisory_lock/);
  assert.match(connectionCalls[1].statement, /pg_advisory_unlock/);
  assert.deepEqual(connectionCalls[2], { op: 'release' });
});

test('withAdvisoryLock unlocks and releases after failed work', async () => {
  const connectionCalls = [];
  const connection = {
    async execute(statement) {
      connectionCalls.push(statement);
      if (/pg_try_advisory_lock/i.test(statement)) return [[{ acquired: true }], []];
      if (/pg_advisory_unlock/i.test(statement)) return [[{ released: true }], []];
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    release() {
      connectionCalls.push('release');
    },
  };
  const repository = createIngestRepository({
    async getConnection() {
      return connection;
    },
  });

  await assert.rejects(
    () =>
      runWithLock(repository, async () => {
        throw new Error('collector failed');
      }),
    /collector failed/,
  );

  assert.match(connectionCalls[1], /pg_advisory_unlock/);
  assert.equal(connectionCalls[2], 'release');
});
