const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createIngestRepository } = require('@/ingest/repositories/ingestRepository');
const { publishCandidates } = require('@/ingest/pipeline/publishCandidates');

function buildCandidate(overrides = {}) {
  return {
    id: 31,
    sourceId: 7,
    canonicalUrl: 'https://example.com/article',
    titleOriginal: 'Original AI title',
    titleZh: '人工智能研究新进展',
    summaryZh: '这是一段中文摘要。',
    sourcePublishedAt: '2026-07-24T01:00:00.000Z',
    contentMode: 'summary',
    licenseCode: 'link-only',
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '摘要' }] }],
    },
    ...overrides,
  };
}

function createPublishingDatabase({ authorRows = [{ id: 2 }], tagRows = [{ id: 13 }], candidateRows = [buildCandidate()], articleIds = [501], failOn } = {}) {
  const calls = [];
  let articleIndex = 0;
  const connection = {
    async beginTransaction() {
      calls.push({ op: 'begin' });
    },
    async execute(statement, params = []) {
      calls.push({ op: 'execute', statement, params });
      if (failOn?.test(statement)) throw new Error('database failure');
      if (/FROM "user"/i.test(statement)) return [authorRows, []];
      if (/FROM tag/i.test(statement)) return [tagRows, []];
      if (/FROM ingest_candidate c/i.test(statement) && /FOR UPDATE/i.test(statement)) {
        return [candidateRows, []];
      }
      if (/INSERT INTO article \(/i.test(statement)) {
        return [{ affectedRows: 1, insertId: articleIds[articleIndex++] }, []];
      }
      return [{ affectedRows: 1, insertId: 0 }, []];
    },
    async commit() {
      calls.push({ op: 'commit' });
    },
    async rollback() {
      calls.push({ op: 'rollback' });
    },
    release() {
      calls.push({ op: 'release' });
    },
  };

  return {
    calls,
    async execute() {
      throw new Error('root execute should not be used for publication');
    },
    async getConnection() {
      calls.push({ op: 'getConnection' });
      return connection;
    },
  };
}

test('approveCandidates only promotes enriched rows selected by id', async () => {
  let query;
  const repository = createIngestRepository({
    async execute(statement, params) {
      query = { statement, params };
      return [{ affectedRows: 2, insertId: 0 }, []];
    },
  });

  const result = await repository.approveCandidates({ ids: [31, 32], limit: 10 });

  assert.deepEqual(result, { approved: 2 });
  assert.match(query.statement, /status = 'enriched'/i);
  assert.match(query.statement, /status = 'approved'/i);
  assert.match(query.statement, /id = ANY\(\?::bigint\[\]\)/i);
  assert.match(query.statement, /FOR UPDATE SKIP LOCKED/i);
  assert.deepEqual(query.params, [[31, 32], 10]);
});

test('publishApproved writes article, tag and attribution before marking the candidate published', async () => {
  const database = createPublishingDatabase();
  const repository = createIngestRepository(database);

  const result = await repository.publishApproved({
    authorName: 'daniel',
    tagName: '人工智能',
    limit: 10,
  });

  assert.deepEqual(result, { published: 1, articleIds: [501] });
  const statements = database.calls.filter((call) => call.statement);
  assert.match(statements[0].statement, /FROM "user"/i);
  assert.match(statements[1].statement, /FROM tag/i);
  assert.match(statements[2].statement, /c\.status = 'approved'/i);
  assert.match(statements[2].statement, /FOR UPDATE OF c SKIP LOCKED/i);
  assert.match(statements[3].statement, /INSERT INTO article/i);
  assert.deepEqual(statements[3].params, [2, '人工智能研究新进展', JSON.stringify(buildCandidate().content), '这是一段中文摘要。']);
  assert.match(statements[4].statement, /INSERT INTO article_tag/i);
  assert.deepEqual(statements[4].params, [501, 13]);
  assert.match(statements[5].statement, /INSERT INTO article_source/i);
  assert.deepEqual(statements[5].params, [501, 31, 7, 'https://example.com/article', 'Original AI title', '2026-07-24T01:00:00.000Z', 'summary', 'link-only']);
  assert.match(statements[6].statement, /status = 'published'/i);
  assert.deepEqual(statements[6].params, [501, 31]);
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
    ['getConnection', 'begin', 'commit', 'release'],
  );
});

test('publishApproved rolls back when the configured author or tag is missing', async () => {
  for (const options of [{ authorRows: [] }, { tagRows: [] }]) {
    const database = createPublishingDatabase(options);
    const repository = createIngestRepository(database);

    await assert.rejects(
      () =>
        repository.publishApproved({
          authorName: 'missing',
          tagName: '人工智能',
          limit: 10,
        }),
      /author not found|tag not found/i,
    );
    assert.deepEqual(
      database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
      ['getConnection', 'begin', 'rollback', 'release'],
    );
    assert.equal(
      database.calls.some((call) => /INSERT INTO article/i.test(call.statement || '')),
      false,
    );
  }
});

test('publishApproved treats an already-published or concurrently claimed batch as a harmless no-op', async () => {
  const database = createPublishingDatabase({ candidateRows: [] });
  const repository = createIngestRepository(database);

  const result = await repository.publishApproved({
    authorName: 'daniel',
    tagName: '人工智能',
    limit: 10,
  });

  assert.deepEqual(result, { published: 0, articleIds: [] });
  assert.equal(
    database.calls.some((call) => /INSERT INTO article/i.test(call.statement || '')),
    false,
  );
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
    ['getConnection', 'begin', 'commit', 'release'],
  );
});

test('publishCandidates requires explicit existing author and tag names', async () => {
  const calls = [];
  const repository = {
    async publishApproved(input) {
      calls.push(input);
      return { published: 0, articleIds: [] };
    },
  };

  await assert.rejects(() => publishCandidates({ repository, authorName: '', tagName: '人工智能', limit: 8 }), /authorName is required/);
  await publishCandidates({
    repository,
    authorName: 'daniel',
    tagName: '人工智能',
    limit: 8,
  });
  assert.deepEqual(calls, [{ authorName: 'daniel', tagName: '人工智能', limit: 8 }]);
});
