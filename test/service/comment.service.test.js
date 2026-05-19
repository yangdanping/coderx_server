const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/comment.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');
const notificationServicePath = path.resolve(__dirname, '../../src/service/notification.service.js');
const eventBusPath = path.resolve(__dirname, '../../src/socket/notification/notificationEventBus.js');

function loadServiceWithConnection(connectionMock, options = {}) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[urlsPath];
  delete require.cache[notificationServicePath];
  delete require.cache[eventBusPath];

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

  require.cache[notificationServicePath] = {
    id: notificationServicePath,
    filename: notificationServicePath,
    loaded: true,
    exports: options.notificationService || {
      async createArticleCommentNotification() {
        return { created: false, notification: null };
      },
      async createCommentReplyNotification() {
        return { created: false, notification: null };
      },
    },
  };

  require.cache[eventBusPath] = {
    id: eventBusPath,
    filename: eventBusPath,
    loaded: true,
    exports: options.eventBus || {
      async publishNotificationCreated() {},
    },
  };

  return require(servicePath);
}

function createConnMock(executeHandler) {
  const calls = [];
  const conn = {
    async beginTransaction() {
      calls.push({ type: 'beginTransaction' });
    },
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      return executeHandler(statement, params, calls);
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
  return { conn, calls };
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

test('getCommentById: pg executes pg-safe replyTo SQL with quoted reply user alias and normalizes avatar hosts', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{
        id: 1,
        content: 'ok',
        status: 0,
        user: {
          id: 2,
          avatarUrl: 'http://localhost:8000/user/2/avatar',
        },
        replyTo: {
          id: 3,
          avatarUrl: 'https://avatars.example/u/3.png',
        },
      }], []];
    },
  });

  const result = await service.getCommentById(12);

  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(calls[0].statement, /JSON_OBJECT/i);
  assert.deepEqual(result, {
    id: 1,
    content: 'ok',
    status: 0,
    user: {
      id: 2,
      avatarUrl: 'https://api.example/user/2/avatar',
    },
    replyTo: {
      id: 3,
      avatarUrl: 'https://avatars.example/u/3.png',
    },
  });
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

test('addComment: creates article comment notification in the same transaction and publishes after commit', async () => {
  const notification = { id: 300, recipientId: 10, actorId: 9, type: 'article_comment', articleId: 12, commentId: 151 };
  const { conn, calls } = createConnMock((statement, params) => {
    if (/INSERT INTO comment/i.test(statement)) {
      return [{ insertId: 151, affectedRows: 1 }, []];
    }

    if (/SELECT user_id AS "authorId" FROM article/i.test(statement)) {
      return [[{ authorId: 10 }], []];
    }

    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) {
      return [[{ id: 151, content: 'hello', status: 0, articleId: 12 }], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createArticleCommentNotification(payload, options) {
          calls.push({ type: 'createNotification', payload, conn: options.conn });
          return { created: true, notification };
        },
      },
      eventBus: {
        async publishNotificationCreated(payload) {
          calls.push({ type: 'publish', payload });
        },
      },
    },
  );

  const result = await service.addComment(9, 12, '<p>hello</p>');

  assert.deepEqual(result, { id: 151, content: 'hello', status: 0, articleId: 12 });
  assert.equal(calls.find((call) => call.type === 'createNotification').conn, conn);
  assert.deepEqual(calls.find((call) => call.type === 'createNotification').payload, {
    recipientId: 10,
    actorId: 9,
    articleId: 12,
    commentId: 151,
    content: '<p>hello</p>',
  });
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
  assert.deepEqual(calls.find((call) => call.type === 'publish').payload, notification);
});

test('addComment: self-comment keeps the comment without creating a notification', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/INSERT INTO comment/i.test(statement)) return [{ insertId: 151, affectedRows: 1 }, []];
    if (/SELECT user_id AS "authorId" FROM article/i.test(statement)) return [[{ authorId: 9 }], []];
    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) return [[{ id: 151, content: 'hello' }], []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createArticleCommentNotification() {
          throw new Error('self-comment should not notify');
        },
      },
      eventBus: {
        async publishNotificationCreated() {
          throw new Error('self-comment should not publish');
        },
      },
    },
  );

  const result = await service.addComment(9, 12, 'hello');

  assert.deepEqual(result, { id: 151, content: 'hello' });
  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});

test('addComment: publish failure does not roll back committed comment and notification', async () => {
  const notification = { id: 300, recipientId: 10, actorId: 9, type: 'article_comment', articleId: 12, commentId: 151 };
  const { conn, calls } = createConnMock((statement) => {
    if (/INSERT INTO comment/i.test(statement)) return [{ insertId: 151, affectedRows: 1 }, []];
    if (/SELECT user_id AS "authorId" FROM article/i.test(statement)) return [[{ authorId: 10 }], []];
    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) return [[{ id: 151, content: 'hello' }], []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createArticleCommentNotification() {
          return { created: true, notification };
        },
      },
      eventBus: {
        async publishNotificationCreated() {
          calls.push({ type: 'publish' });
          throw new Error('redis unavailable');
        },
      },
    },
  );

  const result = await service.addComment(9, 12, 'hello');

  assert.deepEqual(result, { id: 151, content: 'hello' });
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
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

test('addReply: replying to a top-level comment creates a reply notification in the same transaction and publishes after commit', async () => {
  const notification = { id: 400, recipientId: 10, actorId: 9, type: 'comment_reply', articleId: 12, commentId: 33 };
  const { conn, calls } = createConnMock((statement) => {
    if (/INSERT INTO comment/i.test(statement)) {
      return [{ insertId: 181, affectedRows: 1 }, []];
    }

    if (/SELECT user_id AS "authorId" FROM comment/i.test(statement)) {
      return [[{ authorId: 10 }], []];
    }

    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) {
      return [[{ id: 181, content: 'reply', status: 0, cid: 33, articleId: 12 }], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createCommentReplyNotification(payload, options) {
          calls.push({ type: 'createReplyNotification', payload, conn: options.conn });
          return { created: true, notification };
        },
      },
      eventBus: {
        async publishNotificationCreated(payload) {
          calls.push({ type: 'publish', payload });
        },
      },
    },
  );

  const result = await service.addReply(9, 12, 33, null, '<p>reply</p>');

  assert.deepEqual(result, { id: 181, content: 'reply', status: 0, cid: 33, articleId: 12 });
  assert.deepEqual(calls.find((call) => call.type === 'createReplyNotification').payload, {
    recipientId: 10,
    actorId: 9,
    articleId: 12,
    commentId: 33,
    replyId: 181,
    content: '<p>reply</p>',
  });
  assert.equal(calls.find((call) => call.type === 'createReplyNotification').conn, conn);
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
  assert.deepEqual(calls.find((call) => call.type === 'publish').payload, notification);
});

test('addReply: replying to another reply notifies the replied reply author while storing the top-level comment id', async () => {
  const { conn, calls } = createConnMock((statement, params) => {
    if (/INSERT INTO comment/i.test(statement)) {
      return [{ insertId: 182, affectedRows: 1 }, []];
    }

    if (/SELECT user_id AS "authorId" FROM comment/i.test(statement)) {
      assert.deepEqual(params, [44]);
      return [[{ authorId: 11 }], []];
    }

    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) {
      return [[{ id: 182, content: 'nested reply', status: 0, cid: 33, rid: 44, articleId: 12 }], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createCommentReplyNotification(payload, options) {
          calls.push({ type: 'createReplyNotification', payload, conn: options.conn });
          return { created: false, notification: null };
        },
      },
    },
  );

  const result = await service.addReply(9, 12, 33, 44, 'nested reply');

  assert.deepEqual(result, { id: 182, content: 'nested reply', status: 0, cid: 33, rid: 44, articleId: 12 });
  assert.deepEqual(calls.find((call) => call.type === 'createReplyNotification').payload, {
    recipientId: 11,
    actorId: 9,
    articleId: 12,
    commentId: 33,
    replyId: 182,
    content: 'nested reply',
  });
});

test('addReply: self-reply keeps the reply without creating or publishing a notification', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/INSERT INTO comment/i.test(statement)) return [{ insertId: 181, affectedRows: 1 }, []];
    if (/SELECT user_id AS "authorId" FROM comment/i.test(statement)) return [[{ authorId: 9 }], []];
    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) return [[{ id: 181, content: 'self reply' }], []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createCommentReplyNotification() {
          throw new Error('self-reply should not notify');
        },
      },
      eventBus: {
        async publishNotificationCreated() {
          throw new Error('self-reply should not publish');
        },
      },
    },
  );

  const result = await service.addReply(9, 12, 33, null, 'self reply');

  assert.deepEqual(result, { id: 181, content: 'self reply' });
  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});

test('addReply: publish failure does not roll back committed reply and notification', async () => {
  const notification = { id: 400, recipientId: 10, actorId: 9, type: 'comment_reply', articleId: 12, commentId: 33 };
  const { conn, calls } = createConnMock((statement) => {
    if (/INSERT INTO comment/i.test(statement)) return [{ insertId: 181, affectedRows: 1 }, []];
    if (/SELECT user_id AS "authorId" FROM comment/i.test(statement)) return [[{ authorId: 10 }], []];
    if (/FROM comment c/i.test(statement) && /WHERE c\.id = \?/i.test(statement)) return [[{ id: 181, content: 'reply' }], []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createCommentReplyNotification() {
          return { created: true, notification };
        },
      },
      eventBus: {
        async publishNotificationCreated() {
          calls.push({ type: 'publish' });
          throw new Error('redis unavailable');
        },
      },
    },
  );

  const result = await service.addReply(9, 12, 33, null, 'reply');

  assert.deepEqual(result, { id: 181, content: 'reply' });
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
});
