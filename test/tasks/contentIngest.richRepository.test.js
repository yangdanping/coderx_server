const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createRichArticleRepository } = require('@/ingest/repositories/richArticleRepository');

function createDatabase({ failOn, articleRows = [{ articleId: 143 }], authorRows = [{ id: 1 }] } = {}) {
  const calls = [];
  let nextImageId = 501;
  const connection = {
    async beginTransaction() {
      calls.push({ op: 'begin' });
    },
    async execute(statement, params = []) {
      calls.push({ op: 'execute', statement, params });
      if (failOn?.test(statement)) throw new Error('database failure');
      if (/FROM article_source/i.test(statement)) return [articleRows, []];
      if (/FROM "user"/i.test(statement)) return [authorRows, []];
      if (/SELECT f\.id,\s*f\.filename/i.test(statement)) {
        return [[{ id: 490, filename: 'ingest-70-old.jpg' }], []];
      }
      if (/INSERT INTO file/i.test(statement)) {
        return [{ affectedRows: 1, insertId: nextImageId++ }, []];
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
    async execute(statement, params = []) {
      calls.push({ op: 'rootExecute', statement, params });
      return [
        [
          {
            id: 70,
            articleId: 143,
            canonicalUrl: 'https://aws.example/article',
            sourceName: 'AWS',
            sourcePublishedAt: '2026-07-24T00:00:00.000Z',
          },
        ],
        [],
      ];
    },
    async getConnection() {
      calls.push({ op: 'getConnection' });
      return connection;
    },
  };
}

test('listPublishedCandidatesByIds returns only mapped published candidates', async () => {
  const database = createDatabase();
  const repository = createRichArticleRepository(database);

  const rows = await repository.listPublishedCandidatesByIds([70]);

  assert.equal(rows[0].articleId, 143);
  const call = database.calls.find((item) => item.op === 'rootExecute');
  assert.match(call.statement, /c\.status = 'published'/i);
  assert.match(call.statement, /c\.id = ANY\(\?::bigint\[\]\)/i);
  assert.deepEqual(call.params, [[70]]);
});

function buildInput(overrides = {}) {
  return {
    articleId: 143,
    candidateId: 70,
    authorId: 1,
    createAt: new Date('2026-07-10T10:00:00.000Z'),
    title: '生产级人工智能系统的可靠性实践',
    excerpt: '一段用于列表展示的中文导语。',
    assets: [
      {
        filename: 'ingest-70-cover.jpg',
        mimetype: 'image/jpeg',
        size: 1000,
        width: 1200,
        height: 675,
        isCover: true,
        src: 'http://localhost:8000/article/images/ingest-70-cover.jpg',
      },
      {
        filename: 'ingest-70-body.jpg',
        mimetype: 'image/jpeg',
        size: 800,
        width: 900,
        height: 600,
        isCover: false,
        src: 'http://localhost:8000/article/images/ingest-70-body.jpg',
      },
    ],
    buildContent(imageRows) {
      assert.deepEqual(
        imageRows.map((row) => row.id),
        [501, 502],
      );
      return {
        type: 'doc',
        content: imageRows.map((image) => ({ type: 'image', attrs: { imageId: image.id, src: image.src } })),
      };
    },
    ...overrides,
  };
}

test('replacePublishedArticle atomically replaces ingest images, author, content and date', async () => {
  const database = createDatabase();
  const repository = createRichArticleRepository(database);

  const result = await repository.replacePublishedArticle(buildInput());

  assert.deepEqual(result.oldFilenames, ['ingest-70-old.jpg']);
  assert.deepEqual(
    result.images.map((image) => image.id),
    [501, 502],
  );
  const statements = database.calls.filter((call) => call.statement);
  assert.match(statements[0].statement, /FROM article_source[\s\S]*FOR UPDATE/i);
  assert.match(statements[1].statement, /FROM "user"[\s\S]*profile/i);
  assert.match(statements[2].statement, /SELECT f\.id,\s*f\.filename/i);
  assert.match(statements[3].statement, /DELETE FROM file/i);
  assert.match(statements[4].statement, /INSERT INTO file/i);
  assert.match(statements[5].statement, /INSERT INTO image_meta/i);
  assert.match(statements[8].statement, /UPDATE article/i);
  assert.deepEqual(statements[4].params, [1, 143, 'ingest-70-cover.jpg', 'image/jpeg', 1000]);
  assert.deepEqual(statements[5].params, [501, 1200, 675, true]);
  assert.equal(statements[8].params[0], 1);
  assert.equal(statements[8].params[1], '生产级人工智能系统的可靠性实践');
  assert.match(statements[8].params[2], /"imageId":501/);
  assert.equal(statements[8].params[3], '一段用于列表展示的中文导语。');
  assert.equal(statements[8].params[4].toISOString(), '2026-07-10T10:00:00.000Z');
  assert.equal(statements[8].params[5], 143);
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
    ['getConnection', 'begin', 'commit', 'release'],
  );
});

test('replacePublishedArticle rolls back when the mapped article or approved author is missing', async () => {
  for (const options of [{ articleRows: [] }, { authorRows: [] }]) {
    const database = createDatabase(options);
    const repository = createRichArticleRepository(database);

    await assert.rejects(() => repository.replacePublishedArticle(buildInput()), /published article mapping|approved existing author/i);
    assert.deepEqual(
      database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
      ['getConnection', 'begin', 'rollback', 'release'],
    );
  }
});

test('replacePublishedArticle rolls back the entire mutation on persistence failure', async () => {
  const database = createDatabase({ failOn: /UPDATE article/i });
  const repository = createRichArticleRepository(database);

  await assert.rejects(() => repository.replacePublishedArticle(buildInput()), /database failure/);
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
    ['getConnection', 'begin', 'rollback', 'release'],
  );
});
