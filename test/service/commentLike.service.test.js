const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/commentLike.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const notificationServicePath = path.resolve(__dirname, '../../src/service/notification.service.js');
const eventBusPath = path.resolve(__dirname, '../../src/socket/notification/notificationEventBus.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadService({ connection, notificationService, eventBus }) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[notificationServicePath];
  delete require.cache[eventBusPath];

  injectCache(databasePath, connection);
  injectCache(notificationServicePath, notificationService);
  injectCache(eventBusPath, eventBus);

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

test('toggleCommentLike: cancel like only deletes the relation and does not notify', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM comment_like/i.test(statement)) {
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {
      async createCommentLikeNotification() {
        throw new Error('unlike should not notify');
      },
    },
    eventBus: {
      async publishNotificationCreated() {
        throw new Error('unlike should not publish');
      },
    },
  });

  const result = await service.toggleCommentLike(40, 20);

  assert.deepEqual(result, { isLiked: false, action: 'unliked', notificationCreated: false, notification: null });
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'beginTransaction' }, { type: 'commit' }, { type: 'release' }],
  );
});

test('toggleCommentLike: new reply like creates notification in the transaction and publishes after commit', async () => {
  const notification = { id: 90, recipientId: 10, actorId: 20, type: 'comment_like', commentId: 40 };
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM comment_like/i.test(statement)) {
      return [{ affectedRows: 0 }, []];
    }
    if (/FROM comment/i.test(statement)) {
      return [[{ authorId: 10, articleId: 30, parentCommentId: 35, content: '<p>reply body</p>' }], []];
    }
    if (/INSERT INTO comment_like/i.test(statement)) {
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {
      async createCommentLikeNotification(payload, options) {
        calls.push({ type: 'createNotification', payload, conn: options.conn });
        return { created: true, notification };
      },
    },
    eventBus: {
      async publishNotificationCreated(payload) {
        calls.push({ type: 'publish', payload });
      },
    },
  });

  const result = await service.toggleCommentLike(40, 20);

  assert.deepEqual(result, { isLiked: true, action: 'liked', notificationCreated: true, notification });
  assert.equal(calls.find((call) => call.type === 'createNotification').conn, conn);
  assert.deepEqual(calls.find((call) => call.type === 'createNotification').payload, {
    recipientId: 10,
    actorId: 20,
    articleId: 30,
    commentId: 40,
    parentCommentId: 35,
    content: '<p>reply body</p>',
  });
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
  assert.deepEqual(calls.find((call) => call.type === 'publish').payload, notification);
});

test('toggleCommentLike: self-like keeps the relation without creating a notification', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM comment_like/i.test(statement)) {
      return [{ affectedRows: 0 }, []];
    }
    if (/FROM comment/i.test(statement)) {
      return [[{ authorId: 20, articleId: 30, parentCommentId: null, content: 'self' }], []];
    }
    if (/INSERT INTO comment_like/i.test(statement)) {
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {
      async createCommentLikeNotification() {
        throw new Error('self-like should not notify');
      },
    },
    eventBus: {
      async publishNotificationCreated() {
        throw new Error('self-like should not publish');
      },
    },
  });

  const result = await service.toggleCommentLike(40, 20);

  assert.deepEqual(result, { isLiked: true, action: 'liked', notificationCreated: false, notification: null });
  assert.equal(calls.some((call) => call.type === 'commit'), true);
});

test('toggleCommentLike: missing comment rolls back without inserting a like', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM comment_like/i.test(statement)) {
      return [{ affectedRows: 0 }, []];
    }
    if (/FROM comment/i.test(statement)) {
      return [[], []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {},
    eventBus: {},
  });

  await assert.rejects(
    () => service.toggleCommentLike(404, 20),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '评论不存在');
      assert.equal(error.httpStatus, 404);
      return true;
    },
  );

  assert.equal(calls.some((call) => call.type === 'rollback'), true);
  assert.equal(calls.some((call) => call.type === 'commit'), false);
  assert.equal(calls.some((call) => call.statement && /INSERT INTO comment_like/i.test(call.statement)), false);
});

test('toggleCommentLike: publish failure does not roll back the committed like and notification', async () => {
  const notification = { id: 90, recipientId: 10, actorId: 20, type: 'comment_like', commentId: 40 };
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM comment_like/i.test(statement)) return [{ affectedRows: 0 }, []];
    if (/FROM comment/i.test(statement)) {
      return [[{ authorId: 10, articleId: 30, parentCommentId: null, content: 'comment' }], []];
    }
    if (/INSERT INTO comment_like/i.test(statement)) return [{ affectedRows: 1 }, []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {
      async createCommentLikeNotification() {
        return { created: true, notification };
      },
    },
    eventBus: {
      async publishNotificationCreated() {
        calls.push({ type: 'publish' });
        throw new Error('redis unavailable');
      },
    },
  });

  const result = await service.toggleCommentLike(40, 20);

  assert.deepEqual(result, { isLiked: true, action: 'liked', notificationCreated: true, notification });
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
});
