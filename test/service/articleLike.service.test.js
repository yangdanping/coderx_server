const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/articleLike.service.js');
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

test('toggleArticleLike: cancel like only deletes current relation and does not notify', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM article_like/i.test(statement)) {
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const notificationCalls = [];
  const publishCalls = [];
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {
      async createArticleLikeNotification(...args) {
        notificationCalls.push(args);
      },
    },
    eventBus: {
      async publishNotificationCreated(...args) {
        publishCalls.push(args);
      },
    },
  });

  const result = await service.toggleArticleLike('30', 20);

  assert.deepEqual(result, { isLiked: false, action: 'unliked', notificationCreated: false, notification: null });
  assert.deepEqual(notificationCalls, []);
  assert.deepEqual(publishCalls, []);
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'beginTransaction' }, { type: 'commit' }, { type: 'release' }],
  );
});

test('toggleArticleLike: new like creates notification in transaction and publishes after commit', async () => {
  const notification = { id: 88, recipientId: 10, actorId: 20, articleId: 30 };
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM article_like/i.test(statement)) {
      return [{ affectedRows: 0 }, []];
    }
    if (/FROM article/i.test(statement)) {
      return [[{ authorId: 10 }], []];
    }
    if (/INSERT INTO article_like/i.test(statement)) {
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
      async createArticleLikeNotification(payload, options) {
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

  const result = await service.toggleArticleLike(30, 20);

  assert.deepEqual(result, { isLiked: true, action: 'liked', notificationCreated: true, notification });
  assert.equal(calls.find((call) => call.type === 'createNotification').conn, conn);
  assert.deepEqual(calls.find((call) => call.type === 'createNotification').payload, {
    recipientId: 10,
    actorId: 20,
    articleId: 30,
  });
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
  assert.deepEqual(calls.find((call) => call.type === 'publish').payload, notification);
});

test('toggleArticleLike: self-like keeps like relation without creating notification', async () => {
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM article_like/i.test(statement)) {
      return [{ affectedRows: 0 }, []];
    }
    if (/FROM article/i.test(statement)) {
      return [[{ authorId: 20 }], []];
    }
    if (/INSERT INTO article_like/i.test(statement)) {
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
      async createArticleLikeNotification() {
        throw new Error('self-like should not notify');
      },
    },
    eventBus: {
      async publishNotificationCreated() {
        throw new Error('self-like should not publish');
      },
    },
  });

  const result = await service.toggleArticleLike(30, 20);

  assert.deepEqual(result, { isLiked: true, action: 'liked', notificationCreated: false, notification: null });
  assert.equal(calls.some((call) => call.type === 'commit'), true);
});

test('toggleArticleLike: publish failure does not roll back committed like and notification', async () => {
  const notification = { id: 88, recipientId: 10, actorId: 20, articleId: 30 };
  const { conn, calls } = createConnMock((statement) => {
    if (/DELETE FROM article_like/i.test(statement)) return [{ affectedRows: 0 }, []];
    if (/FROM article/i.test(statement)) return [[{ authorId: 10 }], []];
    if (/INSERT INTO article_like/i.test(statement)) return [{ affectedRows: 1 }, []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadService({
    connection: {
      async getConnection() {
        return conn;
      },
    },
    notificationService: {
      async createArticleLikeNotification() {
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

  const result = await service.toggleArticleLike(30, 20);

  assert.deepEqual(result, { isLiked: true, action: 'liked', notificationCreated: true, notification });
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
  assert.ok(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'publish'));
});
