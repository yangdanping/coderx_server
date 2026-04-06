const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/comment.service.js');
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

test('getCommentList latest: pg executes pg-safe comment author SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, content: 'ok', status: 0, createAt: '2024-01-01 00:00:00.000', likes: 0, replyCount: 0 }], []];
    },
  });

  service.getReplyPreview = async () => [];

  await service.getCommentList(7, null, 1, 'latest', 2);

  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(calls[0].statement, /JSON_OBJECT/i);
});

test('getCommentList hot: pg executes pg-safe hot comment SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, content: 'ok', status: 0, createAt: '2024-01-01 00:00:00.000', likes: 5, replyCount: 2 }], []];
    },
  });

  service.getReplyPreview = async () => [];

  await service.getCommentList(7, null, 1, 'hot', 2);

  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(calls[0].statement, /JSON_OBJECT/i);
});

test('getUserCommentList: pg uses LIMIT ? OFFSET ? and limit-first params', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      if (calls.length === 1) {
        return [[{ id: 1, content: 'ok', status: 0, articleId: 3 }], []];
      }
      return [[{ total: 1 }], []];
    },
  });

  const items = await service.getUserCommentList(9, '20', '10');

  assert.equal(items[0].articleUrl, '/article/3');
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.deepEqual(calls[0].params, [9, '10', '20']);
});

test('getReplyPreview: pg executes pg-safe replyTo SQL with quoted reply user alias', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, content: 'ok', status: 0 }], []];
    },
  });

  await service.getReplyPreview(12, 2);

  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(calls[0].statement, /JSON_OBJECT/i);
});

test('getReplies: pg executes pg-safe reply SQL with quoted reply user alias', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      if (calls.length === 1) {
        return [[{ id: 1, content: 'ok', status: 0, createAt: '2024-01-01 00:00:00.000' }], []];
      }
      return [[{ replyCount: 1 }], []];
    },
  });

  await service.getReplies(12, null, 1);

  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(calls[0].statement, /JSON_OBJECT/i);
});

test('getReplies: invalid limit falls back to a safe numeric limit instead of NaN', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      if (calls.length === 1) {
        return [[{ id: 1, content: 'ok', status: 0, createAt: '2024-01-01 00:00:00.000' }], []];
      }
      return [[{ replyCount: 1 }], []];
    },
  });

  await service.getReplies(12, null, 'oops');

  assert.equal(calls[0].params.includes('NaN'), false);
  assert.equal(calls[0].params.at(-1), '11');
});

test('getCommentById: pg executes pg-safe replyTo SQL with quoted reply user alias', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, content: 'ok', status: 0 }], []];
    },
  });

  await service.getCommentById(12);

  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(calls[0].statement, /JSON_OBJECT/i);
});

test('addComment: pg requests insertId through RETURNING id and fetches created comment by id', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      if (calls.length === 1) {
        return [{ insertId: /RETURNING\s+id/i.test(statement) ? 151 : 0, affectedRows: 1 }, []];
      }
      return [[{ id: 151, content: 'hello', status: 0 }], []];
    },
  });

  const result = await service.addComment(9, 12, 'hello');

  assert.deepEqual(result, { id: 151, content: 'hello', status: 0 });
  assert.match(calls[0].statement, /INSERT INTO comment \(user_id, article_id, content\) VALUES \(\?, \?, \?\) RETURNING id;$/i);
  assert.deepEqual(calls[0].params, [9, 12, 'hello']);
  assert.deepEqual(calls[1].params, [151]);
});

test('addReply: pg requests insertId through RETURNING id for nested reply path and fetches created comment by id', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      if (calls.length === 1) {
        return [{ insertId: /RETURNING\s+id/i.test(statement) ? 181 : 0, affectedRows: 1 }, []];
      }
      return [[{ id: 181, content: 'reply', status: 0, rid: 44 }], []];
    },
  });

  const result = await service.addReply(9, 12, 33, 44, 'reply');

  assert.deepEqual(result, { id: 181, content: 'reply', status: 0, rid: 44 });
  assert.match(
    calls[0].statement,
    /INSERT INTO comment \(user_id, article_id, comment_id, reply_id, content\) VALUES \(\?, \?, \?, \?, \?\) RETURNING id;$/i
  );
  assert.deepEqual(calls[0].params, [9, 12, 33, 44, 'reply']);
  assert.deepEqual(calls[1].params, [181]);
});
