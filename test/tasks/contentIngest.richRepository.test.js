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

test('listRawCandidatesByIds accepts mapped published and unmapped pending candidates', async () => {
  const database = createDatabase();
  database.execute = async (statement, params = []) => {
    database.calls.push({ op: 'rootExecute', statement, params });
    return [
      [
        {
          id: 3,
          articleId: null,
          status: 'pending',
          sourceId: 2,
          canonicalUrl: 'https://openai.com/article',
          titleOriginal: 'OpenAI article',
          sourcePublishedAt: '2026-07-28T00:00:00.000Z',
          contentMode: 'summary',
          licenseCode: 'link-only',
          sourceName: 'OpenAI',
        },
        {
          id: 70,
          articleId: 143,
          status: 'published',
          sourceId: 1,
          canonicalUrl: 'https://aws.example/article',
          titleOriginal: 'AWS article',
          sourcePublishedAt: '2026-07-24T00:00:00.000Z',
          contentMode: 'summary',
          licenseCode: 'link-only',
          sourceName: 'AWS',
        },
      ],
      [],
    ];
  };
  const repository = createRichArticleRepository(database);

  const rows = await repository.listRawCandidatesByIds([70, 3]);

  assert.deepEqual(
    rows.map((row) => [row.id, row.status]),
    [
      [3, 'pending'],
      [70, 'published'],
    ],
  );
  const call = database.calls.find((item) => item.op === 'rootExecute');
  assert.match(call.statement, /c\.status = 'pending'[\s\S]*c\.article_id IS NULL/i);
  assert.match(call.statement, /c\.status = 'published'[\s\S]*c\.article_id IS NOT NULL/i);
  assert.match(call.statement, /NOT EXISTS[\s\S]*article_source/i);
  assert.match(call.statement, /EXISTS[\s\S]*article_source/i);
  assert.deepEqual(call.params, [[70, 3]]);
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

function buildPendingInput(overrides = {}) {
  return {
    candidateId: 3,
    authorId: 2,
    createAt: new Date('2026-07-28T10:00:00.000Z'),
    tagName: '人工智能',
    title: 'Introducing the ChatGPT for small business program',
    excerpt: 'Small businesses can use ChatGPT to support daily work.',
    assets: [
      {
        filename: 'ingest-3-cover.jpg',
        mimetype: 'image/jpeg',
        size: 1000,
        width: 1200,
        height: 675,
        isCover: true,
        src: 'http://localhost:8000/article/images/ingest-3-cover.jpg',
      },
    ],
    buildContent(images) {
      return {
        type: 'doc',
        content: images.map((image) => ({
          type: 'image',
          attrs: { imageId: image.id, src: image.src },
        })),
      };
    },
    ...overrides,
  };
}

function createPendingPublicationDatabase({
  candidateRows = [
    {
      id: 3,
      sourceId: 2,
      canonicalUrl: 'https://openai.com/article',
      titleOriginal: 'Introducing the ChatGPT for small business program',
      sourcePublishedAt: '2026-07-28T00:00:00.000Z',
      contentMode: 'summary',
      licenseCode: 'link-only',
    },
  ],
  authorRows = [{ id: 2 }],
  tagRows = [{ id: 13 }],
  conflictRows = [],
  candidateUpdateAffectedRows = 1,
  failOn,
} = {}) {
  const calls = [];
  const connection = {
    async beginTransaction() {
      calls.push({ op: 'begin' });
    },
    async execute(statement, params = []) {
      calls.push({ op: 'execute', statement, params });
      if (failOn?.test(statement)) throw new Error('database failure');
      if (/FROM ingest_candidate c/i.test(statement) && /FOR UPDATE OF c/i.test(statement)) {
        return [candidateRows, []];
      }
      if (/FROM "user"/i.test(statement)) return [authorRows, []];
      if (/FROM tag/i.test(statement)) return [tagRows, []];
      if (/FROM article_source/i.test(statement)) return [conflictRows, []];
      if (/INSERT INTO article \(/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 601 }, []];
      }
      if (/INSERT INTO file/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 701 }, []];
      }
      if (/UPDATE ingest_candidate/i.test(statement)) {
        return [{ affectedRows: candidateUpdateAffectedRows, insertId: 0 }, []];
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
    async getConnection() {
      calls.push({ op: 'getConnection' });
      return connection;
    },
  };
}

test('publishRawArticle atomically creates article, image, tag, source and candidate mapping', async () => {
  const database = createPendingPublicationDatabase();
  const repository = createRichArticleRepository(database);

  const result = await repository.publishRawArticle(buildPendingInput());

  assert.equal(result.articleId, 601);
  assert.deepEqual(
    result.images.map((image) => image.id),
    [701],
  );
  assert.deepEqual(result.oldFilenames, []);

  const statements = database.calls.filter((call) => call.statement);
  assert.match(statements[0].statement, /FROM ingest_candidate[\s\S]*FOR UPDATE OF c/i);
  assert.match(statements[1].statement, /FROM "user"[\s\S]*profile/i);
  assert.match(statements[2].statement, /FROM tag/i);
  assert.match(statements[3].statement, /FROM article_source/i);
  assert.match(statements[4].statement, /INSERT INTO article/i);
  assert.match(statements[5].statement, /INSERT INTO file/i);
  assert.match(statements[6].statement, /INSERT INTO image_meta/i);
  assert.match(statements[7].statement, /UPDATE article/i);
  assert.match(statements[8].statement, /INSERT INTO article_tag/i);
  assert.match(statements[9].statement, /INSERT INTO article_source/i);
  assert.match(statements[10].statement, /UPDATE ingest_candidate/i);
  assert.deepEqual(statements[4].params, [
    2,
    'Introducing the ChatGPT for small business program',
    JSON.stringify({ type: 'doc', content: [] }),
    'Small businesses can use ChatGPT to support daily work.',
    new Date('2026-07-28T10:00:00.000Z'),
  ]);
  assert.deepEqual(statements[5].params, [2, 601, 'ingest-3-cover.jpg', 'image/jpeg', 1000]);
  assert.deepEqual(statements[6].params, [701, 1200, 675, true]);
  assert.match(statements[7].params[0], /"imageId":701/);
  assert.deepEqual(statements[8].params, [601, 13]);
  assert.deepEqual(statements[10].params, [601, 3]);
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
    ['getConnection', 'begin', 'commit', 'release'],
  );
});

test('publishRawArticle rolls back when the candidate, author, tag or source identity is invalid', async () => {
  const cases = [
    { options: { candidateRows: [] }, message: /eligible pending candidate/i },
    { options: { authorRows: [] }, message: /approved existing author/i },
    { options: { tagRows: [] }, message: /article tag not found/i },
    { options: { conflictRows: [{ articleId: 500 }] }, message: /source mapping already exists/i },
    { options: { candidateUpdateAffectedRows: 0 }, message: /changed during publication/i },
  ];

  for (const scenario of cases) {
    const database = createPendingPublicationDatabase(scenario.options);
    const repository = createRichArticleRepository(database);

    await assert.rejects(() => repository.publishRawArticle(buildPendingInput()), scenario.message);
    assert.deepEqual(
      database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
      ['getConnection', 'begin', 'rollback', 'release'],
    );
  }
});

test('publishRawArticle rolls back the complete publication on persistence failure', async () => {
  const database = createPendingPublicationDatabase({ failOn: /INSERT INTO image_meta/i });
  const repository = createRichArticleRepository(database);

  await assert.rejects(() => repository.publishRawArticle(buildPendingInput()), /database failure/i);
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute').map((call) => call.op),
    ['getConnection', 'begin', 'rollback', 'release'],
  );
});

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

test('listPlaceholderArticles returns only exact candidate-linked placeholder documents', async () => {
  const placeholder = {
    type: 'doc',
    content: [
      { type: 'heading', content: [{ type: 'text', text: '摘要' }] },
      { type: 'heading', content: [{ type: 'text', text: '为什么值得阅读' }] },
      { type: 'heading', content: [{ type: 'text', text: '来源' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '阅读原文 ↗', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }],
      },
    ],
  };
  const database = createDatabase();
  database.execute = async (statement, params = []) => {
    database.calls.push({ op: 'rootExecute', statement, params });
    return [
      [
        {
          articleId: 144,
          candidateId: 71,
          title: 'Placeholder',
          canonicalUrl: 'https://example.com',
          sourceName: 'Example',
          content: placeholder,
          filenames: [],
        },
        {
          articleId: 143,
          candidateId: 70,
          title: 'Rich article',
          canonicalUrl: 'https://example.com/rich',
          sourceName: 'Example',
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Full body' }] }] },
          filenames: [],
        },
      ],
      [],
    ];
  };
  const repository = createRichArticleRepository(database);

  const rows = await repository.listPlaceholderArticles();

  assert.deepEqual(rows.map((row) => row.articleId), [144]);
});

test('deletePlaceholderArticles rechecks locked rows and rejects their candidates transactionally', async () => {
  const database = createDatabase();
  const placeholder = {
    type: 'doc',
    content: [
      { type: 'heading', content: [{ type: 'text', text: '摘要' }] },
      { type: 'heading', content: [{ type: 'text', text: '为什么值得阅读' }] },
      { type: 'heading', content: [{ type: 'text', text: '来源' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '阅读原文 ↗', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }],
      },
    ],
  };
  const connection = await database.getConnection();
  connection.execute = async (statement, params = []) => {
    database.calls.push({ op: 'execute', statement, params });
    if (/FOR UPDATE OF a/i.test(statement)) {
      return [
        [
          {
            articleId: 144,
            candidateId: 71,
            title: 'Placeholder',
            canonicalUrl: 'https://example.com',
            sourceName: 'Example',
            content: placeholder,
            filenames: [],
          },
        ],
        [],
      ];
    }
    return [{ affectedRows: 1 }, []];
  };
  database.getConnection = async () => connection;
  const repository = createRichArticleRepository(database);

  const rows = await repository.deletePlaceholderArticles([144]);

  assert.deepEqual(rows.map((row) => row.articleId), [144]);
  const statements = database.calls.filter((call) => call.statement);
  assert.match(statements[0].statement, /FOR UPDATE OF a/i);
  assert.match(statements[1].statement, /DELETE FROM article/i);
  assert.match(statements[2].statement, /UPDATE ingest_candidate/i);
  assert.deepEqual(statements[1].params, [[144]]);
  assert.deepEqual(statements[2].params, [[71]]);
  assert.deepEqual(
    database.calls.filter((call) => call.op !== 'execute' && call.op !== 'getConnection').map((call) => call.op),
    ['begin', 'commit', 'release'],
  );
});
