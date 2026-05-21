const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/notification.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
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

test('createArticleLikeNotification: self-like does not open a transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection for self-like');
    },
  });

  const result = await service.createArticleLikeNotification({
    recipientId: 7,
    actorId: 7,
    articleId: 20,
  });

  assert.equal(getConnectionCalled, false);
  assert.deepEqual(result, { created: false, notification: null, reason: 'self' });
});

test('createArticleLikeNotification: first like locks key, inserts notification, and commits', async () => {
  const notification = {
    id: 88,
    recipientId: 10,
    actorId: 20,
    type: 'article_like',
    targetType: 'article',
    targetId: 30,
    articleId: 30,
    readAt: null,
    createdAt: new Date('2026-05-13T00:00:00.000Z'),
    lastOccurredAt: new Date('2026-05-13T00:00:00.000Z'),
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    const executeCount = calls.filter((call) => call.type === 'execute').length;

    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[], []];
    }

    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL #${executeCount}: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createArticleLikeNotification({
    recipientId: 10,
    actorId: 20,
    articleId: 30,
  });

  assert.deepEqual(result, { created: true, notification });
  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.match(executeCalls[0].statement, /pg_advisory_xact_lock/i);
  assert.deepEqual(executeCalls[0].params, ['article_like:10:20:article:30']);
  assert.match(executeCalls[1].statement, /ORDER BY\s+created_at\s+DESC\s+LIMIT\s+1/i);
  assert.deepEqual(executeCalls[1].params, [10, 20, 'article_like', 'article', 30]);
  assert.match(executeCalls[2].statement, /INSERT INTO notifications/i);
  assert.deepEqual(executeCalls[2].params, [10, 20, 'article_like', 'article', 30, 30, null, '{}']);
  assert.deepEqual(executeCalls[3].params, [88]);
  assert.deepEqual(calls.filter((call) => call.type !== 'execute'), [
    { type: 'beginTransaction' },
    { type: 'commit' },
    { type: 'release' },
  ]);
});

test('createCommentReplyNotification: stores the created reply id in metadata', async () => {
  const notification = {
    id: 401,
    recipientId: 10,
    actorId: 9,
    type: 'comment_reply',
    targetType: 'article',
    targetId: 12,
    articleId: 12,
    commentId: 33,
    metadata: {
      commentExcerpt: 'reply body',
      replyId: 181,
    },
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createCommentReplyNotification({
    recipientId: 10,
    actorId: 9,
    articleId: 12,
    commentId: 33,
    replyId: 181,
    content: '<p>reply body</p>',
  });

  assert.deepEqual(result, { created: true, notification });
  const insertCall = calls.find((call) => call.type === 'execute' && /INSERT INTO notifications/i.test(call.statement));
  assert.deepEqual(insertCall.params, [
    10,
    9,
    'comment_reply',
    'article',
    12,
    12,
    33,
    JSON.stringify({ commentExcerpt: 'reply body', replyId: 181 }),
  ]);
});

test('createCommentReplyNotification: stores the recipient role in metadata when provided', async () => {
  const notification = {
    id: 402,
    recipientId: 10,
    actorId: 9,
    type: 'comment_reply',
    targetType: 'article',
    targetId: 12,
    articleId: 12,
    commentId: 33,
    metadata: {
      commentExcerpt: 'reply body',
      replyId: 181,
      recipientRole: 'article_author',
    },
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createCommentReplyNotification({
    recipientId: 10,
    actorId: 9,
    articleId: 12,
    commentId: 33,
    replyId: 181,
    content: '<p>reply body</p>',
    recipientRole: 'article_author',
  });

  assert.deepEqual(result, { created: true, notification });
  const insertCall = calls.find((call) => call.type === 'execute' && /INSERT INTO notifications/i.test(call.statement));
  assert.deepEqual(insertCall.params, [
    10,
    9,
    'comment_reply',
    'article',
    12,
    12,
    33,
    JSON.stringify({ commentExcerpt: 'reply body', replyId: 181, recipientRole: 'article_author' }),
  ]);
});

test('createArticleLikeNotification: repeated like inside cooldown does not insert or touch old unread state', async () => {
  const nowMs = Date.parse('2026-05-13T10:00:00.000Z');
  const latest = {
    id: 70,
    createdAt: new Date(nowMs - 30 * 60 * 1000),
    readAt: null,
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[latest], []];
    }

    throw new Error(`Should not insert inside cooldown: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createArticleLikeNotification(
    {
      recipientId: 10,
      actorId: 20,
      articleId: 30,
    },
    { nowMs },
  );

  assert.deepEqual(result, {
    created: false,
    notification: null,
    reason: 'cooldown',
    latestNotification: latest,
  });
  assert.equal(calls.some((call) => call.statement && /INSERT INTO notifications/i.test(call.statement)), false);
  assert.equal(calls.some((call) => call.statement && /UPDATE notifications/i.test(call.statement)), false);
  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});

test('createArticleLikeNotification: like after cooldown creates a new notification', async () => {
  const nowMs = Date.parse('2026-05-13T10:00:00.000Z');
  const notification = { id: 99, recipientId: 10, actorId: 20, articleId: 30 };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[{ id: 70, createdAt: new Date(nowMs - 2 * 60 * 60 * 1000), readAt: null }], []];
    }

    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createArticleLikeNotification(
    {
      recipientId: 10,
      actorId: 20,
      articleId: 30,
    },
    { nowMs },
  );

  assert.deepEqual(result, { created: true, notification });
  assert.equal(calls.some((call) => call.statement && /INSERT INTO notifications/i.test(call.statement)), true);
});

test('createFollowNotification: self-follow does not open a transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection for self-follow');
    },
  });

  const result = await service.createFollowNotification({
    recipientId: 7,
    actorId: 7,
  });

  assert.equal(getConnectionCalled, false);
  assert.deepEqual(result, { created: false, notification: null, reason: 'self' });
});

test('createFollowNotification: first follow locks key, inserts notification, and commits', async () => {
  const notification = {
    id: 501,
    recipientId: 10,
    actorId: 20,
    type: 'follow',
    targetType: 'user',
    targetId: 10,
    articleId: null,
    commentId: null,
    metadata: {},
    readAt: null,
    createdAt: new Date('2026-05-13T00:00:00.000Z'),
    lastOccurredAt: new Date('2026-05-13T00:00:00.000Z'),
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[], []];
    }

    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createFollowNotification({
    recipientId: 10,
    actorId: 20,
  });

  assert.deepEqual(result, { created: true, notification });
  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.match(executeCalls[0].statement, /pg_advisory_xact_lock/i);
  assert.deepEqual(executeCalls[0].params, ['follow:10:20:user:10']);
  assert.deepEqual(executeCalls[1].params, [10, 20, 'follow', 'user', 10]);
  assert.deepEqual(executeCalls[2].params, [10, 20, 'follow', 'user', 10, null, null, '{}']);
});

test('createFollowNotification: repeated follow inside seven-day cooldown does not insert', async () => {
  const nowMs = Date.parse('2026-05-20T10:00:00.000Z');
  const latest = {
    id: 500,
    createdAt: new Date(nowMs - 6 * 24 * 60 * 60 * 1000),
    readAt: null,
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[latest], []];
    }

    throw new Error(`Should not insert inside follow cooldown: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createFollowNotification(
    {
      recipientId: 10,
      actorId: 20,
    },
    { nowMs },
  );

  assert.deepEqual(result, {
    created: false,
    notification: null,
    reason: 'cooldown',
    latestNotification: latest,
  });
  assert.equal(calls.some((call) => call.statement && /INSERT INTO notifications/i.test(call.statement)), false);
  assert.equal(calls.some((call) => call.statement && /UPDATE notifications/i.test(call.statement)), false);
});

test('createFollowNotification: follow after seven-day cooldown creates a new notification', async () => {
  const nowMs = Date.parse('2026-05-20T10:00:00.000Z');
  const notification = {
    id: 502,
    recipientId: 10,
    actorId: 20,
    type: 'follow',
    targetType: 'user',
    targetId: 10,
    articleId: null,
  };
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[{ id: 500, createdAt: new Date(nowMs - 8 * 24 * 60 * 60 * 1000), readAt: null }], []];
    }

    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createFollowNotification(
    {
      recipientId: 10,
      actorId: 20,
    },
    { nowMs },
  );

  assert.deepEqual(result, { created: true, notification });
  assert.equal(calls.some((call) => call.statement && /INSERT INTO notifications/i.test(call.statement)), true);
});

test('createArticleLikeNotification: evaluates cooldown after waiting for the advisory lock', async () => {
  const originalDateNow = Date.now;
  const latestCreatedAtMs = Date.parse('2026-05-13T10:00:00.000Z');
  let currentNowMs = latestCreatedAtMs + serviceCooldownMs() - 1;
  const notification = { id: 100, recipientId: 10, actorId: 20, articleId: 30 };
  const { conn } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      currentNowMs = latestCreatedAtMs + serviceCooldownMs() + 1;
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[{ id: 70, createdAt: new Date(latestCreatedAtMs), readAt: null }], []];
    }

    if (/INSERT INTO notifications/i.test(statement)) {
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });
  Date.now = () => currentNowMs;

  try {
    const result = await service.createArticleLikeNotification({
      recipientId: 10,
      actorId: 20,
      articleId: 30,
    });

    assert.deepEqual(result, { created: true, notification });
  } finally {
    Date.now = originalDateNow;
  }
});

test('createArticleLikeNotification: rolls back and releases connection when insert path fails', async () => {
  const { conn, calls } = createTransactionalMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) {
      return [[{}], []];
    }

    if (/FROM notifications/i.test(statement) && /ORDER BY created_at DESC/i.test(statement)) {
      return [[], []];
    }

    if (/INSERT INTO notifications/i.test(statement)) {
      throw new Error('database unavailable');
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () =>
      service.createArticleLikeNotification({
        recipientId: 10,
        actorId: 20,
        articleId: 30,
      }),
    /database unavailable/,
  );

  assert.equal(calls.some((call) => call.type === 'rollback'), true);
  assert.equal(calls.some((call) => call.type === 'commit'), false);
  assert.equal(calls.some((call) => call.type === 'release'), true);
});

test('createArticleCommentNotification: creates a notification with sanitized comment excerpt and no cooldown lookup', async () => {
  const notification = {
    id: 188,
    recipientId: 10,
    actorId: 20,
    type: 'article_comment',
    targetType: 'article',
    targetId: 30,
    articleId: 30,
    commentId: 40,
    metadata: { commentExcerpt: 'hello world' },
    readAt: null,
    createdAt: new Date('2026-05-13T00:00:00.000Z'),
    lastOccurredAt: new Date('2026-05-13T00:00:00.000Z'),
  };
  const { conn, calls } = createTransactionalMock((statement, params) => {
    if (/INSERT INTO notifications/i.test(statement)) {
      assert.equal(params[2], 'article_comment');
      assert.equal(params[6], 40);
      assert.deepEqual(JSON.parse(params[7]), { commentExcerpt: 'hello world' });
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createArticleCommentNotification({
    recipientId: 10,
    actorId: 20,
    articleId: 30,
    commentId: 40,
    content: '<p>hello&nbsp;<strong>world</strong></p>',
  });

  assert.deepEqual(result, { created: true, notification });
  assert.equal(calls.some((call) => call.statement && /pg_advisory_xact_lock/i.test(call.statement)), false);
  assert.equal(calls.some((call) => call.statement && /ORDER BY created_at DESC/i.test(call.statement)), false);
  assert.deepEqual(calls.filter((call) => call.type !== 'execute'), [
    { type: 'beginTransaction' },
    { type: 'commit' },
    { type: 'release' },
  ]);
});

test('createArticleCommentNotification: self-comment does not open a transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection for self-comment');
    },
  });

  const result = await service.createArticleCommentNotification({
    recipientId: 7,
    actorId: 7,
    articleId: 20,
    commentId: 30,
    content: 'self',
  });

  assert.equal(getConnectionCalled, false);
  assert.deepEqual(result, { created: false, notification: null, reason: 'self' });
});

test('createCommentReplyNotification: creates a notification with sanitized reply excerpt and no cooldown lookup', async () => {
  const notification = {
    id: 288,
    recipientId: 10,
    actorId: 20,
    type: 'comment_reply',
    targetType: 'article',
    targetId: 30,
    articleId: 30,
    commentId: 40,
    metadata: { commentExcerpt: 'reply text' },
    readAt: null,
    createdAt: new Date('2026-05-13T00:00:00.000Z'),
    lastOccurredAt: new Date('2026-05-13T00:00:00.000Z'),
  };
  const { conn, calls } = createTransactionalMock((statement, params) => {
    if (/INSERT INTO notifications/i.test(statement)) {
      assert.equal(params[2], 'comment_reply');
      assert.equal(params[3], 'article');
      assert.equal(params[4], 30);
      assert.equal(params[5], 30);
      assert.equal(params[6], 40);
      assert.deepEqual(JSON.parse(params[7]), { commentExcerpt: 'reply text' });
      return [{ insertId: notification.id, affectedRows: 1 }, []];
    }

    if (/FROM notifications/i.test(statement) && /WHERE n\.id = \?/i.test(statement)) {
      return [[notification], []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = loadServiceWithConnection({
    async getConnection() {
      return conn;
    },
  });

  const result = await service.createCommentReplyNotification({
    recipientId: 10,
    actorId: 20,
    articleId: 30,
    commentId: 40,
    content: '<p>reply&nbsp;<em>text</em></p>',
  });

  assert.deepEqual(result, { created: true, notification });
  assert.equal(calls.some((call) => call.statement && /pg_advisory_xact_lock/i.test(call.statement)), false);
  assert.equal(calls.some((call) => call.statement && /ORDER BY created_at DESC/i.test(call.statement)), false);
  assert.deepEqual(calls.filter((call) => call.type !== 'execute'), [
    { type: 'beginTransaction' },
    { type: 'commit' },
    { type: 'release' },
  ]);
});

test('createCommentReplyNotification: self-reply does not open a transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection for self-reply');
    },
  });

  const result = await service.createCommentReplyNotification({
    recipientId: 7,
    actorId: 7,
    articleId: 20,
    commentId: 30,
    content: 'self',
  });

  assert.equal(getConnectionCalled, false);
  assert.deepEqual(result, { created: false, notification: null, reason: 'self' });
});

test('notification service: list, unread count, and read mutations use recipient-scoped SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });

      if (/COUNT\(\*\)::bigint AS count/i.test(statement)) {
        return [[{ count: '3' }], []];
      }

      if (/UPDATE notifications/i.test(statement)) {
        return [{ affectedRows: 2 }, []];
      }

      return [[{ id: 1, recipientId: 10 }], []];
    },
  });

  assert.deepEqual(await service.getNotificationList(10, { offset: 20, limit: 5 }), [{ id: 1, recipientId: 10 }]);
  assert.equal(await service.getUnreadCount(10), 3);
  assert.deepEqual(await service.markAsRead(99, 10), { affectedRows: 2 });
  assert.deepEqual(await service.markAllAsRead(10), { affectedRows: 2 });

  assert.match(calls[0].statement, /WHERE n\.recipient_id = \?/i);
  assert.deepEqual(calls[0].params, [10, 5, 20]);
  assert.match(calls[1].statement, /read_at IS NULL/i);
  assert.deepEqual(calls[1].params, [10]);
  assert.match(calls[2].statement, /WHERE id = \? AND recipient_id = \?/i);
  assert.deepEqual(calls[2].params, [99, 10]);
  assert.match(calls[3].statement, /WHERE recipient_id = \? AND read_at IS NULL/i);
  assert.deepEqual(calls[3].params, [10]);
});

function serviceCooldownMs() {
  return 60 * 60 * 1000;
}
