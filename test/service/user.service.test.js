const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/user.service.js');
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
    exports:
      options.notificationService || {
        async createFollowNotification() {
          return { created: false, notification: null };
        },
      },
  };

  require.cache[eventBusPath] = {
    id: eventBusPath,
    filename: eventBusPath,
    loaded: true,
    exports: {
      publishNotificationCreated:
        options.publishNotificationCreated ||
        (async () => {
          throw new Error('publishNotificationCreated should not be called');
        }),
    },
  };

  return require(servicePath);
}

function createTransactionalMock(executeHandler) {
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

test('getUserByName: pg executes query against quoted user table', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, name: 'alice' }], []];
    },
  });

  const user = await service.getUserByName('alice');

  assert.deepEqual(user, { id: 1, name: 'alice' });
  assert.match(calls[0].statement, /FROM\s+"user"\s+WHERE\s+name\s*=\s*\?/i);
  assert.doesNotMatch(calls[0].statement, /FROM\s+user\s+WHERE\s+name\s*=\s*\?/i);
  assert.deepEqual(calls[0].params, ['alice']);
});

test('getCommentById: pg uses limit-first params and pg-safe author SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 2, title: 'hello', content: 'world', likes: 0 }], []];
    },
  });

  const comments = await service.getCommentById(9, '20', '10');

  assert.deepEqual(comments, [{ id: 2, title: 'hello', content: 'world', likes: 0 }]);
  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.deepEqual(calls[0].params, [9, '10', '20']);
});

test('getHotUsers: normalizes legacy avatar hosts to the current public API origin', async () => {
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute() {
      return [[
        { id: 2, name: 'legacy-user', avatarUrl: 'http://localhost:8000/user/2/avatar' },
        { id: 3, name: 'external-user', avatarUrl: 'https://avatars.example/u/3.png' },
      ], []];
    },
  });

  const users = await service.getHotUsers();

  assert.deepEqual(users, [
    { id: 2, name: 'legacy-user', avatarUrl: 'https://api.example/user/2/avatar' },
    { id: 3, name: 'external-user', avatarUrl: 'https://avatars.example/u/3.png' },
  ]);
});

test('getArticleByCollectId: pg reads excerpt instead of legacy content for collected articles', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 3, title: 'hello', excerpt: 'preview' }], []];
    },
  });

  const articles = await service.getArticleByCollectId(9, 5, '20', '10');

  assert.deepEqual(articles, [{ id: 3, title: 'hello', excerpt: 'preview' }]);
  assert.match(calls[0].statement, /a\.excerpt\s+AS\s+"excerpt"/i);
  assert.doesNotMatch(calls[0].statement, /\ba\.content\b/i);
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.deepEqual(calls[0].params, [9, 5, '10', '20']);
});

test('toggleLike: invalid table name throws BusinessError instead of ReferenceError', async () => {
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute() {
      throw new Error('execute should not be called for invalid table name');
    },
  });

  await assert.rejects(
    () => service.toggleLike('invalid_table', 1, 2),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '非法的表名');
      assert.equal(error.httpStatus, 400);
      return true;
    }
  );
});

test('addUser: pg quotes reserved user table in insert statement while keeping transaction flow', async () => {
  const calls = [];
  const connectionMock = {
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (calls.filter((call) => call.type === 'execute').length === 1) {
            return [{ insertId: /RETURNING\s+id/i.test(statement) ? 11 : 0, affectedRows: 1 }, []];
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
  };

  const service = loadServiceWithConnection(connectionMock);
  const result = await service.addUser({ name: 'alice', password: 'secret' }); // pragma: allowlist secret

  assert.equal(result.insertId, 11);
  const firstExecute = calls.find((call) => call.type === 'execute');
  assert.match(firstExecute.statement, /INSERT INTO\s+"user"\s*\(name,\s*password\)\s*VALUES\s*\(\?,\s*\?\)/i);
  assert.match(firstExecute.statement, /RETURNING\s+id/i);
  assert.deepEqual(firstExecute.params, ['alice', 'secret']);
  const secondExecute = calls.filter((call) => call.type === 'execute')[1];
  assert.deepEqual(secondExecute.params, [11]);
});

test('toggleFollow: unfollow commits silently without creating or publishing notifications', async () => {
  const notificationCalls = [];
  const publishCalls = [];
  const { conn, calls } = createTransactionalMock((statement, params) => {
    assert.match(statement, /DELETE FROM user_follow/i);
    assert.deepEqual(params, [10, 20]);
    return [{ affectedRows: 1 }, []];
  });
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return conn;
      },
    },
    {
      notificationService: {
        async createFollowNotification(...args) {
          notificationCalls.push(args);
          return { created: true, notification: { id: 1 } };
        },
      },
      async publishNotificationCreated(notification) {
        publishCalls.push(notification);
      },
    },
  );

  const result = await service.toggleFollow(10, 20);

  assert.deepEqual(result, {
    isFollowed: false,
    action: 'unfollowed',
    notificationCreated: false,
    notification: null,
  });
  assert.deepEqual(notificationCalls, []);
  assert.deepEqual(publishCalls, []);
  assert.deepEqual(calls.filter((call) => call.type !== 'execute'), [
    { type: 'beginTransaction' },
    { type: 'commit' },
    { type: 'release' },
  ]);
});

test('toggleFollow: new follow creates notification in the transaction and publishes after commit', async () => {
  const notification = { id: 501, recipientId: 10, actorId: 20, type: 'follow' };
  const notificationCalls = [];
  const publishCalls = [];
  const { conn, calls } = createTransactionalMock((statement, params) => {
    if (/DELETE FROM user_follow/i.test(statement)) {
      assert.deepEqual(params, [10, 20]);
      return [{ affectedRows: 0 }, []];
    }

    if (/INSERT INTO user_follow/i.test(statement)) {
      assert.deepEqual(params, [10, 20]);
      return [{ affectedRows: 1 }, []];
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
        async createFollowNotification(payload, options) {
          notificationCalls.push({ payload, options });
          return { created: true, notification };
        },
      },
      async publishNotificationCreated(payload) {
        publishCalls.push(payload);
      },
    },
  );

  const result = await service.toggleFollow(10, 20);

  assert.deepEqual(result, {
    isFollowed: true,
    action: 'followed',
    notificationCreated: true,
    notification,
  });
  assert.deepEqual(notificationCalls.map((call) => call.payload), [{ recipientId: 10, actorId: 20 }]);
  assert.equal(notificationCalls[0].options.conn, conn);
  assert.deepEqual(publishCalls, [notification]);
  assert.equal(calls.findIndex((call) => call.type === 'commit') < calls.findIndex((call) => call.type === 'release'), true);
});

test('toggleFollow: publish failure does not roll back committed follow and notification', async () => {
  const notification = { id: 502, recipientId: 10, actorId: 20, type: 'follow' };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/DELETE FROM user_follow/i.test(statement)) {
      return [{ affectedRows: 0 }, []];
    }

    if (/INSERT INTO user_follow/i.test(statement)) {
      return [{ affectedRows: 1 }, []];
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
        async createFollowNotification() {
          return { created: true, notification };
        },
      },
      async publishNotificationCreated() {
        throw new Error('redis unavailable');
      },
    },
  );

  const result = await service.toggleFollow(10, 20);

  assert.deepEqual(result, {
    isFollowed: true,
    action: 'followed',
    notificationCreated: true,
    notification,
  });
  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});
