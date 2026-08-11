const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const BusinessError = require('@/errors/BusinessError');
const servicePath = path.resolve(__dirname, '../../src/service/article.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');
const utilsPath = path.resolve(__dirname, '../../src/utils/index.js');
const mediaRuntimePath = path.resolve(__dirname, '../../src/service/mediaRuntime.service.js');
const localMediaCleanupPath = path.resolve(__dirname, '../../src/service/localMediaCleanup.service.js');

function loadServiceWithConnection(connectionMock, mediaRuntimeMock = null, localMediaCleanupMock = null) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[urlsPath];
  delete require.cache[utilsPath];
  delete require.cache[mediaRuntimePath];
  delete require.cache[localMediaCleanupPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  require.cache[urlsPath] = {
    id: urlsPath,
    filename: urlsPath,
    loaded: true,
    exports: {
      baseURL: 'https://api.example',
      redirectURL: 'https://app.example',
    },
  };

  require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    exports: {},
  };

  require.cache[mediaRuntimePath] = {
    id: mediaRuntimePath,
    filename: mediaRuntimePath,
    loaded: true,
    exports: mediaRuntimeMock || {
      async resolveImageUrl(fileId) {
        return fileId === 11 ? 'https://api.example/article/images/current-image.png' : null;
      },
    },
  };

  require.cache[localMediaCleanupPath] = {
    id: localMediaCleanupPath,
    filename: localMediaCleanupPath,
    loaded: true,
    exports: localMediaCleanupMock || {
      buildLocalCleanupEntries() {
        return [];
      },
      async enqueueInTransaction() {
        return [];
      },
      async processPending() {
        return { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
      },
    },
  };

  return require(servicePath);
}

function buildStructuredDoc(text = '结构化正文') {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function createConnMock(handlers) {
  const calls = [];
  const conn = {
    async execute(statement, params) {
      calls.push({ target: 'conn', statement, params });
      if (handlers.execute) {
        return handlers.execute(statement, params, calls);
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      if (/UPDATE draft/i.test(statement) && /consumed/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 55, content: buildStructuredDoc('来自草稿'), meta: {} }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      return [[], []];
    },
    async beginTransaction() {
      calls.push({ target: 'conn', op: 'beginTransaction' });
    },
    async commit() {
      calls.push({ target: 'conn', op: 'commit' });
    },
    async rollback() {
      calls.push({ target: 'conn', op: 'rollback' });
    },
    release() {
      calls.push({ target: 'conn', op: 'release' });
    },
  };
  conn.calls = calls;
  return conn;
}

test('addArticle: pg requests insertId through RETURNING id (transactional path)', async () => {
  const conn = createConnMock({});
  const poolCalls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      poolCalls.push('getConnection');
      return conn;
    },
  });

  const contentJson = buildStructuredDoc('结构化正文');
  const result = await service.addArticle(9, 'Title', null, contentJson);

  assert.equal(result.insertId, 301);
  const insertCall = conn.calls.find(
    (c) => c.statement && /INSERT INTO article \(user_id,title, content, excerpt\) VALUES \(\?,\?,\?::jsonb,\?\) RETURNING id;/i.test(c.statement),
  );
  assert.ok(insertCall, 'expected INSERT article on connection');
  assert.deepEqual(insertCall.params, [9, 'Title', JSON.stringify(contentJson), '结构化正文']);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'commit' }, { op: 'release' }],
  );
  assert.deepEqual(poolCalls, ['getConnection']);
});

test('addArticle with draftId: locks standalone draft, inserts article, consumes draft, commits', async () => {
  const conn = createConnMock({});
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await service.addArticle(9, 'Title', 12);

  const stmts = conn.calls.filter((c) => c.statement).map((c) => c.statement);
  assert.match(stmts[0], /FROM draft/i);
  assert.match(stmts[0], /draft_type\s*=\s*'article'/i);
  assert.match(stmts[0], /article_id IS NULL/i);
  assert.match(stmts[0], /FOR UPDATE/i);
  assert.match(stmts[1], /INSERT INTO article/i);
  assert.match(stmts[2], /UPDATE draft/i);
  assert.match(stmts[2], /draft_type\s*=\s*'article'/i);
  assert.match(stmts[2], /consumed_article_id/i);
  assert.equal(
    stmts.some((statement) => /UPDATE file/i.test(statement)),
    false,
  );
  const lockCall = conn.calls.find((c) => /FROM draft/i.test(c.statement || ''));
  assert.deepEqual(lockCall.params, [12, 9]);
  const insertCall = conn.calls.find((c) => /INSERT INTO article/i.test(c.statement || ''));
  assert.deepEqual(insertCall.params, [9, 'Title', JSON.stringify(buildStructuredDoc('来自草稿')), '来自草稿']);
  const consumeCall = conn.calls.find((c) => /UPDATE draft/i.test(c.statement || '') && /consumed/i.test(c.statement));
  assert.deepEqual(consumeCall.params, [12, 9, 301]);
});

test('addArticle with invalid draftId: rejects before opening transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection');
    },
  });

  await assert.rejects(
    () => service.addArticle(9, 'Title', 'oops'),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.message, '参数错误: draftId 必须是正整数');
      return true;
    },
  );

  assert.equal(getConnectionCalled, false);
});

test('addArticle with draftId: missing draft after lock throws 404 and rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[], []];
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.addArticle(9, 'Title', 12),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, '草稿不存在');
      return true;
    },
  );
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('addArticle with draftId: consume affects no rows rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 12, content: buildStructuredDoc('来自草稿'), meta: {} }], []];
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        return [{ affectedRows: 0, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.addArticle(9, 'Title', 12),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.message, '草稿不存在');
      return true;
    },
  );
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('addArticle with draftId: consume execute throws rolls back', async () => {
  const boom = new Error('db consume failed');
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 12, content: buildStructuredDoc('来自草稿'), meta: {} }], []];
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        throw boom;
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.addArticle(9, 'Title', 12), boom);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update without draftId: updates article in a transaction', async () => {
  const conn = createConnMock({});
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  const contentJson = buildStructuredDoc('结构化更新');
  await service.update(7, 'T', 100, null, contentJson);

  const updateCall = conn.calls.find((c) => c.statement && /UPDATE article SET title/i.test(c.statement));
  assert.ok(updateCall);
  assert.doesNotMatch(updateCall.statement, /content_html/i);
  assert.deepEqual(updateCall.params, ['T', JSON.stringify(contentJson), '结构化更新', 100]);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'commit' }, { op: 'release' }],
  );
});

test('update with draftId: locks article-linked draft then updates then consumes', async () => {
  const conn = createConnMock({});
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await service.update(7, 'T', 100, 44);

  const lockCall = conn.calls.find((c) => /FROM draft/i.test(c.statement || ''));
  assert.ok(lockCall);
  assert.match(lockCall.statement, /draft_type\s*=\s*'article'/i);
  assert.match(lockCall.statement, /article_id = \$3/i);
  assert.deepEqual(lockCall.params, [44, 7, 100]);
  const updateCall = conn.calls.find((c) => /UPDATE article SET title/i.test(c.statement || ''));
  assert.doesNotMatch(updateCall.statement, /content_html/i);
  assert.deepEqual(updateCall.params, ['T', JSON.stringify(buildStructuredDoc('来自草稿')), '来自草稿', 100]);
  const consumeCall = conn.calls.find((c) => /UPDATE draft/i.test(c.statement || '') && /consumed/i.test(c.statement));
  assert.match(consumeCall.statement, /draft_type\s*=\s*'article'/i);
  assert.deepEqual(consumeCall.params, [44, 7, 100]);
  const stmts = conn.calls.filter((c) => c.statement).map((c) => c.statement);
  assert.equal(
    stmts.some((statement) => /UPDATE file/i.test(statement)),
    false,
  );
});

test('update with invalid draftId: rejects before opening transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection');
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', 100, 'oops'),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.message, '参数错误: draftId 必须是正整数');
      return true;
    },
  );

  assert.equal(getConnectionCalled, false);
});

test('update with draftId: article update affects no rows and rolls back without consuming draft', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 44, content: buildStructuredDoc('来自草稿'), meta: {} }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 0, insertId: 0 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', 100, 44),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, '文章不存在');
      return true;
    },
  );

  const executeCalls = conn.calls.filter((c) => c.statement);
  assert.equal(executeCalls.filter((c) => /UPDATE draft/i.test(c.statement)).length, 0);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update with draftId: consume affects no rows and rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 44, content: buildStructuredDoc('来自草稿'), meta: {} }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        return [{ affectedRows: 0, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', 100, 44),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, '草稿不存在');
      return true;
    },
  );

  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update with draftId: consume execute throws and rolls back', async () => {
  const boom = new Error('draft consume failed');
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 44, content: buildStructuredDoc('来自草稿'), meta: {} }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        throw boom;
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.update(7, 'T', 100, 44), boom);

  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update with draftId: missing draft throws 404 and rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', 100, 44),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, '草稿不存在');
      return true;
    },
  );
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('getArticleById: derives detail html from structured content without reading stored content_html', async () => {
  const executeCalls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      executeCalls.push({ statement, params });
      return [
        [
          {
            id: 9,
            title: 'derived detail',
            contentJson: { type: 'doc', content: [] },
            contentHtml: '<p>stale html from column</p>',
            excerpt: '摘要',
            images: [],
            videos: [],
            status: 0,
          },
        ],
        [],
      ];
    },
  });

  const result = await service.getArticleById(9);

  assert.equal(executeCalls.length, 1);
  assert.equal(result.contentHtml, '');
  assert.equal(result.excerpt, '摘要');
});

test('getArticleById: hydrates legacy avatar and media src from stable ids', async () => {
  const service = loadServiceWithConnection(
    {
      async execute() {
        return [
          [
            {
              id: 62,
              title: 'legacy media article',
              excerpt: '',
              status: 0,
              author: {
                id: 3,
                avatarUrl: 'http://localhost:8000/user/3/avatar',
              },
              contentJson: {
                type: 'doc',
                content: [
                  {
                    type: 'image',
                    attrs: {
                      imageId: 11,
                      src: 'http://localhost:8000/article/images/legacy-image.png',
                      alt: 'demo',
                    },
                  },
                  {
                    type: 'video',
                    attrs: {
                      videoId: 22,
                      src: 'http://localhost:8000/article/video/legacy-video.mp4',
                      poster: 'http://localhost:8000/article/video/legacy-poster.png',
                    },
                  },
                ],
              },
              contentHtml: '<p>stale html from column</p>',
              images: [{ id: 11, url: 'https://api.example/article/images/current-image.png' }],
              videos: [
                {
                  id: 22,
                  url: 'https://api.example/article/video/current-video.mp4',
                  poster: 'https://api.example/article/video/current-poster.png',
                },
              ],
            },
          ],
          [],
        ];
      },
    },
    {
      async resolveImageUrl(fileId, options) {
        assert.equal(fileId, 11);
        assert.deepEqual(options, { variant: 'original' });
        return 'https://media.example/articles/62/images/11/hash-original.png';
      },
      async resolveVideoUrl(fileId) {
        assert.equal(fileId, 22);
        return 'https://media.example/articles/62/videos/22/hash-video.mp4';
      },
      async resolveVideoPosterUrl(fileId) {
        assert.equal(fileId, 22);
        return 'https://media.example/articles/62/videos/22/hash-poster.jpg';
      },
    },
  );

  const result = await service.getArticleById(62);

  assert.equal(result.author.avatarUrl, 'https://api.example/user/3/avatar');
  assert.equal(result.contentJson.content[0].attrs.src, 'https://media.example/articles/62/images/11/hash-original.png');
  assert.equal(result.contentJson.content[1].attrs.src, 'https://media.example/articles/62/videos/22/hash-video.mp4');
  assert.equal(result.contentJson.content[1].attrs.poster, 'https://media.example/articles/62/videos/22/hash-poster.jpg');
  assert.match(result.contentHtml, /hash-original\.png/);
  assert.match(result.contentHtml, /hash-video\.mp4/);
  assert.match(result.contentHtml, /hash-poster\.jpg/);
});

test('getArticleList: resolves the selected cover through the shared small-image URL resolver', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async execute(statement, params) {
        calls.push({ statement, params });
        if (/COUNT\(DISTINCT a\.id\)/i.test(statement)) {
          return [[{ total: 1 }], []];
        }
        return [
          [
            {
              id: 62,
              title: 'stage 3',
              excerpt: 'summary',
              status: 0,
              coverFileId: 11,
            },
          ],
          [],
        ];
      },
    },
    {
      async resolveImageUrl(fileId, options) {
        assert.equal(fileId, 11);
        assert.deepEqual(options, { variant: 'small' });
        return 'https://media.example/articles/62/images/11/hash-small.png';
      },
    },
  );

  const result = await service.getArticleList(0, 10);

  assert.equal(result[0].cover, 'https://media.example/articles/62/images/11/hash-small.png');
  assert.equal(Object.prototype.hasOwnProperty.call(result[0], 'coverFileId'), false);
});

test('getArticleList: preserves a null cover when the article has no cover image', async () => {
  const service = loadServiceWithConnection(
    {
      async execute(statement) {
        if (/COUNT\(DISTINCT a\.id\)/i.test(statement)) {
          return [[{ total: 1 }], []];
        }
        return [
          [
            {
              id: 63,
              title: 'without cover',
              excerpt: 'summary',
              status: 0,
              coverFileId: null,
            },
          ],
          [],
        ];
      },
    },
    {
      async resolveImageUrl() {
        throw new Error('resolver must not run without a cover file id');
      },
    },
  );

  const result = await service.getArticleList(0, 10);

  assert.equal(result[0].cover, null);
  assert.equal(Object.prototype.hasOwnProperty.call(result[0], 'coverFileId'), false);
});

test('getRandomTocArticle: returns one qualifying article id from the JSONB query', async () => {
  const executeCalls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      executeCalls.push({ statement, params });
      return [[{ id: 77 }], []];
    },
  });

  const result = await service.getRandomTocArticle();

  assert.deepEqual(result, { id: 77 });
  assert.equal(executeCalls.length, 1);
  assert.match(executeCalls[0].statement, /jsonb_path_query_array/i);
  assert.deepEqual(executeCalls[0].params, []);
});

test('getRandomTocArticle: reports 404 when no article can demonstrate a table of contents', async () => {
  const service = loadServiceWithConnection({
    async execute() {
      return [[], []];
    },
  });

  await assert.rejects(
    () => service.getRandomTocArticle(),
    (error) => {
      assert.ok(error instanceof BusinessError);
      assert.equal(error.httpStatus, 404);
      assert.equal(error.message, '暂无可体验目录的文章');
      return true;
    },
  );
});

test('delete: removes staged image objects from R2 before deleting file and article rows', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() {
      calls.push({ type: 'begin' });
    },
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM article/i.test(statement) && /FOR UPDATE/i.test(statement)) {
        return [[{ id: 9 }], []];
      }
      if (/FOR UPDATE OF f/i.test(statement)) {
        return [[{ id: 41, filename: 'cover.jpg', file_type: 'image', poster: null }], []];
      }
      if (/DELETE FROM article/i.test(statement)) return [{ affectedRows: 1 }, []];
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
    release() {
      calls.push({ type: 'release' });
    },
  };
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      async deleteR2ObjectsForFiles(fileIds) {
        calls.push({ type: 'deleteR2', fileIds });
        return { staged: 2, deleted: 2 };
      },
    },
  );

  const result = await service.delete(9, 5);

  assert.deepEqual(result.imagesToDelete, [{ id: 41, filename: 'cover.jpg' }]);
  const r2Index = calls.findIndex((call) => call.type === 'deleteR2');
  const deleteFileIndex = calls.findIndex((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement));
  assert.ok(r2Index >= 0);
  assert.ok(deleteFileIndex > r2Index);
  assert.deepEqual(calls[r2Index].fileIds, [41]);
});

test('delete: R2 failure rolls back and preserves file rows for a safe retry', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() {
      calls.push({ type: 'begin' });
    },
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM article/i.test(statement) && /FOR UPDATE/i.test(statement)) return [[{ id: 9 }], []];
      if (/FOR UPDATE OF f/i.test(statement)) {
        return [[{ id: 41, filename: 'cover.jpg', file_type: 'image', poster: null }], []];
      }
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
    release() {
      calls.push({ type: 'release' });
    },
  };
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      async deleteR2ObjectsForFiles() {
        throw new Error('R2 unavailable');
      },
    },
  );
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(service.delete(9, 5), /R2 unavailable/);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(
    calls.some((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement)),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'rollback'),
    true,
  );
});

test('delete: locks all article media and stages image, video and poster objects before row deletion', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() {
      calls.push({ type: 'begin' });
    },
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM article/i.test(statement) && /FOR UPDATE/i.test(statement)) return [[{ id: 9 }], []];
      if (/FOR UPDATE OF f/i.test(statement)) {
        return [
          [
            { id: 41, filename: 'cover.jpg', file_type: 'image', poster: null },
            { id: 51, filename: 'clip.mp4', file_type: 'video', poster: 'clip-poster.jpg' },
          ],
          [],
        ];
      }
      if (/DELETE FROM article/i.test(statement)) return [{ affectedRows: 1 }, []];
      return [{ affectedRows: 2 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
    release() {},
  };
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      async deleteR2ObjectsForFiles(fileIds) {
        calls.push({ type: 'deleteR2', fileIds });
        return { staged: 4, deleted: 4 };
      },
    },
    {
      buildLocalCleanupEntries(rows) {
        calls.push({ type: 'buildLocal', rows });
        return [
          { storageArea: 'image', filename: 'cover.jpg' },
          { storageArea: 'image', filename: 'cover-small.jpg' },
          { storageArea: 'video', filename: 'clip.mp4' },
          { storageArea: 'video', filename: 'clip-poster.jpg' },
        ];
      },
      async enqueueInTransaction(conn, entries) {
        calls.push({ type: 'enqueueLocal', entries });
        return [701, 702, 703, 704];
      },
      async processPending(options) {
        calls.push({ type: 'processLocal', options });
        return { examined: 4, deleted: 4, missing: 0, failed: 0, pendingIds: [] };
      },
    },
  );

  const result = await service.delete(9, 5);

  assert.deepEqual(result.imagesToDelete, [{ id: 41, filename: 'cover.jpg' }]);
  assert.deepEqual(result.videosToDelete, [{ id: 51, filename: 'clip.mp4', poster: 'clip-poster.jpg' }]);
  const articleLockIndex = calls.findIndex((call) => call.type === 'execute' && /FROM article/i.test(call.statement) && /FOR UPDATE/i.test(call.statement));
  const lockIndex = calls.findIndex((call) => call.type === 'execute' && /FOR UPDATE OF f/i.test(call.statement));
  const r2Index = calls.findIndex((call) => call.type === 'deleteR2');
  const deleteFileIndex = calls.findIndex((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement));
  assert.ok(articleLockIndex >= 0 && lockIndex > articleLockIndex);
  assert.deepEqual(calls[articleLockIndex].params, [9, 5]);
  assert.ok(r2Index > lockIndex);
  assert.ok(deleteFileIndex > r2Index);
  assert.deepEqual(calls[r2Index].fileIds, [41, 51]);
  const enqueueIndex = calls.findIndex((call) => call.type === 'enqueueLocal');
  const commitIndex = calls.findIndex((call) => call.type === 'commit');
  const processIndex = calls.findIndex((call) => call.type === 'processLocal');
  assert.ok(enqueueIndex > r2Index && deleteFileIndex > enqueueIndex);
  assert.ok(processIndex > commitIndex);
  assert.deepEqual(calls[processIndex].options, { ids: [701, 702, 703, 704] });
});

test('delete: active FFmpeg processing blocks article deletion before R2 or database mutation', async () => {
  const calls = [];
  const conn = {
    async beginTransaction() {},
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM article/i.test(statement) && /FOR UPDATE/i.test(statement)) return [[{ id: 9 }], []];
      if (/FOR UPDATE OF f/i.test(statement)) {
        return [
          [
            {
              id: 51,
              filename: 'clip.mp4',
              file_type: 'video',
              poster: null,
              transcode_status: 'processing',
            },
          ],
          [],
        ];
      }
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
    release() {},
  };
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      async deleteR2ObjectsForFiles() {
        calls.push({ type: 'deleteR2' });
      },
    },
  );
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(service.delete(9, 5), /视频仍在处理/);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(
    calls.some((call) => call.type === 'deleteR2'),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement)),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'rollback'),
    true,
  );
});
