const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/draft.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[urlsPath];

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

  return require(servicePath);
}

test('upsertDraft: new draft inserts row, validates file refs, and binds draft_id inside one transaction', async () => {
  const calls = [];
  const content = { type: 'doc', content: [] };
  const inputMeta = { imageIds: [11, true, '9007199254740993'], videoIds: null, coverImageId: 11, selectedTagIds: [3] };
  const normalizedMeta = { imageIds: [11], videoIds: [], coverImageId: 11, selectedTagIds: [3] };

  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          const executeCount = calls.filter((call) => call.type === 'execute').length;

          if (executeCount === 1) {
            return [{ affectedRows: 1, insertId: 41 }, []];
          }

          if (executeCount === 2) {
            return [[{ id: 41, articleId: null, title: 'Draft', content, meta: normalizedMeta, version: 1 }], []];
          }

          if (executeCount === 3) {
            return [[{ id: 11, articleId: null }], []];
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
    },
  });

  const result = await service.upsertDraft(9, {
    articleId: null,
    title: 'Draft',
    content,
    meta: inputMeta,
    version: 0,
  });

  assert.deepEqual(result, { id: 41, articleId: null, title: 'Draft', content, meta: normalizedMeta, version: 1 });

  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.match(executeCalls[0].statement, /INSERT INTO draft/i);
  assert.deepEqual(executeCalls[0].params, [9, null, 'Draft', JSON.stringify(content), JSON.stringify(normalizedMeta), 0]);

  assert.match(executeCalls[1].statement, /FROM draft/i);
  assert.match(executeCalls[1].statement, /status\s*=\s*'active'/i);
  assert.deepEqual(executeCalls[1].params, [9]);

  assert.match(executeCalls[2].statement, /FROM file/i);
  assert.deepEqual(executeCalls[2].params, [9, [11], null, 41]);

  assert.match(executeCalls[3].statement, /UPDATE file SET draft_id = NULL/i);
  assert.deepEqual(executeCalls[3].params, [9, 41, [11]]);

  assert.match(executeCalls[4].statement, /UPDATE file SET draft_id = \$2/i);
  assert.deepEqual(executeCalls[4].params, [9, 41, [11]]);

  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});

test('upsertDraft: direct service call rejects invalid articleId before starting transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not acquire connection');
    },
  });

  await assert.rejects(
    () =>
      service.upsertDraft(9, {
        articleId: '9007199254740993',
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: 0,
      }),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '参数错误: articleId 必须是正整数');
      assert.equal(error.httpStatus, 400);
      return true;
    }
  );

  assert.equal(getConnectionCalled, false);
});

test('upsertDraft: direct service call rejects invalid version before starting transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not acquire connection');
    },
  });

  await assert.rejects(
    () =>
      service.upsertDraft(9, {
        articleId: null,
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: '1e2',
      }),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '参数错误: version 必须是非负整数');
      assert.equal(error.httpStatus, 400);
      return true;
    }
  );

  assert.equal(getConnectionCalled, false);
});

test('upsertDraft: direct service call normalizes decimal-string articleId across follow-up queries', async () => {
  const calls = [];
  const content = { type: 'doc', content: [] };
  const meta = {};
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          const executeCount = calls.filter((call) => call.type === 'execute').length;

          if (executeCount === 1) {
            return [[{ id: 12 }], []];
          }

          if (executeCount === 2) {
            return [{ affectedRows: 1 }, []];
          }

          if (executeCount === 3) {
            return [[{ id: 41, articleId: 12, title: 'Draft', content, meta, version: 1 }], []];
          }

          return [[], []];
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
    },
  });

  const result = await service.upsertDraft(9, {
    articleId: '12',
    title: 'Draft',
    content,
    meta,
    version: '1',
  });

  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.deepEqual(result, { id: 41, articleId: 12, title: 'Draft', content, meta, version: 1 });
  assert.deepEqual(executeCalls[0].params, [12, 9]);
  assert.deepEqual(executeCalls[1].params, [9, 12, 'Draft', JSON.stringify(content), JSON.stringify(meta), 1]);
  assert.deepEqual(executeCalls[2].params, [9, 12]);
  assert.deepEqual(executeCalls[3].params, [9, [], 12, 41]);
});

test('upsertDraft: zero affected rows becomes 409 conflict and rolls back transaction', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          return [{ affectedRows: 0, insertId: 0 }, []];
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
    },
  });

  await assert.rejects(
    () =>
      service.upsertDraft(9, {
        articleId: null,
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: { imageIds: [], videoIds: [] },
        version: 3,
      }),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '草稿版本冲突');
      assert.equal(error.httpStatus, 409);
      return true;
    }
  );

  assert.equal(calls.some((call) => call.type === 'commit'), false);
  assert.equal(calls.some((call) => call.type === 'rollback'), true);
});

test('getDraft: article draft checks ownership first and returns the matching draft', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });

      if (calls.length === 1) {
        return [[{ id: 7 }], []];
      }

      return [[{ id: 51, articleId: 7, version: 4 }], []];
    },
  });

  const result = await service.getDraft(9, 7);

  assert.deepEqual(result, { id: 51, articleId: 7, version: 4 });
  assert.match(calls[0].statement, /SELECT\s+id\s+FROM article/i);
  assert.deepEqual(calls[0].params, [7, 9]);
  assert.match(calls[1].statement, /FROM draft/i);
  assert.match(calls[1].statement, /status\s*=\s*'active'/i);
  assert.deepEqual(calls[1].params, [9, 7]);
});

test('getDraft: standalone draft lookup is active-only', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 51, articleId: null, version: 3 }], []];
    },
  });

  const result = await service.getDraft(9, null);

  assert.deepEqual(result, { id: 51, articleId: null, version: 3 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].statement, /FROM draft/i);
  assert.match(calls[0].statement, /status\s*=\s*'active'/i);
  assert.deepEqual(calls[0].params, [9]);
});

test('getDraft: hydrates media src and poster from stable file ids for editor backfill', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });

      if (calls.length === 1) {
        return [[{
          id: 51,
          articleId: null,
          version: 3,
          content: {
            type: 'doc',
            content: [
              {
                type: 'image',
                attrs: {
                  imageId: 11,
                  src: 'http://localhost:8000/article/images/legacy-image.png',
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
        }], []];
      }

      if (calls.length === 2) {
        return [[
          { id: 11, filename: 'fresh-image.png', file_type: 'image' },
          { id: 22, filename: 'fresh-video.mp4', file_type: 'video' },
        ], []];
      }

      if (calls.length === 3) {
        return [[{ file_id: 22, poster: 'fresh-poster.png' }], []];
      }

      return [[], []];
    },
  });

  const result = await service.getDraft(9, null);

  assert.equal(result.content.content[0].attrs.src, 'https://api.example/article/images/fresh-image.png');
  assert.equal(result.content.content[1].attrs.src, 'https://api.example/article/video/fresh-video.mp4');
  assert.equal(result.content.content[1].attrs.poster, 'https://api.example/article/video/fresh-poster.png');
  assert.deepEqual(calls[1].params, [[11, 22]]);
  assert.deepEqual(calls[2].params, [[22]]);
});

test('getDraft: article draft returns null when there is no active draft', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });

      if (calls.length === 1) {
        return [[{ id: 7 }], []];
      }

      return [[], []];
    },
  });

  const result = await service.getDraft(9, 7);

  assert.equal(result, null);
  assert.match(calls[1].statement, /FROM draft/i);
  assert.match(calls[1].statement, /status\s*=\s*'active'/i);
  assert.deepEqual(calls[1].params, [9, 7]);
});

test('getDraft: direct service call rejects invalid articleId', async () => {
  let executeCalled = false;
  const service = loadServiceWithConnection({
    async execute() {
      executeCalled = true;
      return [[], []];
    },
  });

  await assert.rejects(
    () => service.getDraft(9, '9007199254740993'),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '参数错误: articleId 必须是正整数');
      assert.equal(error.httpStatus, 400);
      return true;
    }
  );

  assert.equal(executeCalled, false);
});

test('getDraft: direct service call accepts decimal-string articleId and uses normalized params', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });

      if (calls.length === 1) {
        return [[{ id: 12 }], []];
      }

      return [[{ id: 51, articleId: 12, version: 4 }], []];
    },
  });

  const result = await service.getDraft(9, '12');

  assert.deepEqual(result, { id: 51, articleId: 12, version: 4 });
  assert.deepEqual(calls[0].params, [12, 9]);
  assert.deepEqual(calls[1].params, [9, 12]);
});

test('getDraft: missing owned article becomes 404 for article draft lookup', async () => {
  const service = loadServiceWithConnection({
    async execute() {
      return [[], []];
    },
  });

  await assert.rejects(
    () => service.getDraft(9, 7),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '文章不存在或无权限');
      assert.equal(error.httpStatus, 404);
      return true;
    }
  );
});

test('deleteDraft: owner discard marks discarded and returns id', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          return [{ affectedRows: 1, insertId: 88 }, []];
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
    },
  });

  const result = await service.deleteDraft(9, 88);
  const executeCalls = calls.filter((call) => call.type === 'execute');

  assert.deepEqual(result, { id: 88 });
  assert.match(executeCalls[0].statement, /UPDATE\s+draft/i);
  assert.match(executeCalls[0].statement, /status\s*=\s*'discarded'/i);
  assert.match(executeCalls[0].statement, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2\s+AND\s+status\s*=\s*'active'/is);
  assert.deepEqual(executeCalls[0].params, [88, 9]);
  assert.match(executeCalls[1].statement, /UPDATE file SET draft_id = NULL/i);
  assert.deepEqual(executeCalls[1].params, [9, 88, []]);
  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});

test('deleteDraft: non-active draft yields 404', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          return [{ affectedRows: 0 }, []];
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
    },
  });

  await assert.rejects(
    () => service.deleteDraft(9, 88),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '草稿不存在');
      assert.equal(error.httpStatus, 404);
      return true;
    }
  );

  assert.equal(calls.filter((call) => call.type === 'execute').length, 1);
  assert.equal(calls.some((call) => call.type === 'commit'), false);
  assert.equal(calls.some((call) => call.type === 'rollback'), true);
});

test('deleteDraft: file unbind failure rolls back discard transaction', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          const executeCount = calls.filter((call) => call.type === 'execute').length;

          if (executeCount === 1) {
            return [{ affectedRows: 1 }, []];
          }

          throw new Error('unbind failed');
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
    },
  });

  await assert.rejects(() => service.deleteDraft(9, 88), /unbind failed/);

  assert.equal(calls.filter((call) => call.type === 'execute').length, 2);
  assert.equal(calls.some((call) => call.type === 'commit'), false);
  assert.equal(calls.some((call) => call.type === 'rollback'), true);
});

test('deleteDraft: direct service call rejects invalid draftId before opening transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not acquire connection');
    },
  });

  await assert.rejects(
    () => service.deleteDraft(9, '9007199254740993'),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '参数错误: draftId 必须是正整数');
      assert.equal(error.httpStatus, 400);
      return true;
    }
  );

  assert.equal(getConnectionCalled, false);
});

test('deleteDraft: direct service call accepts decimal-string draftId and uses normalized params', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
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
    },
  });

  const result = await service.deleteDraft(9, '88');
  const executeCalls = calls.filter((call) => call.type === 'execute');

  assert.deepEqual(result, { id: 88 });
  assert.deepEqual(executeCalls[0].params, [88, 9]);
  assert.deepEqual(executeCalls[1].params, [9, 88, []]);
});
