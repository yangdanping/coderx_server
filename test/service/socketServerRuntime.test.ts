import test from 'node:test';
import assert from 'node:assert/strict';

import { startSocketServer } from '../../src/socket/runtime/socketServerRuntime.js';

function createFakeLogger(calls) {
  return {
    log(...args) {
      calls.push(['log', ...args]);
    },
    error(...args) {
      calls.push(['error', ...args]);
    },
  };
}

test('socketServerRuntime: initializes Redis adapter before online service and listen', async () => {
  const calls = [];
  const io = { id: 'io' };
  const onlinePresenceOptions = { presenceRefreshIntervalMs: 30_000 };
  const httpServer = {
    listen(port, callback) {
      calls.push(['listen', port]);
      callback();
    },
  };

  const result = await startSocketServer({
    httpServer,
    io,
    port: 9001,
    redirectURL: 'http://localhost:8080',
    logger: createFakeLogger(calls),
    configureRedisAdapter: async (receivedIo) => {
      calls.push(['configureRedisAdapter', receivedIo]);
    },
    initializeOnlinePresence: (receivedIo, receivedOptions) => {
      calls.push(['initializeOnlinePresence', receivedIo, receivedOptions]);
    },
    onlinePresenceOptions,
  });

  assert.equal(result.httpServer, httpServer);
  assert.equal(result.io, io);
  assert.deepEqual(calls.slice(0, 3), [
    ['configureRedisAdapter', io],
    ['initializeOnlinePresence', io, onlinePresenceOptions],
    ['listen', 9001],
  ]);
});

test('socketServerRuntime: adapter startup failure prevents online service and listen', async () => {
  const calls = [];
  const io = { id: 'io' };
  const httpServer = {
    listen() {
      calls.push(['listen']);
    },
  };

  await assert.rejects(
    () =>
      startSocketServer({
        httpServer,
        io,
        port: 9001,
        logger: createFakeLogger(calls),
        configureRedisAdapter: async () => {
          calls.push(['configureRedisAdapter']);
          throw new Error('Socket.IO Redis Adapter 初始化失败: redis unavailable');
        },
        initializeOnlinePresence: () => {
          calls.push(['initializeOnlinePresence']);
        },
      }),
    /Socket\.IO Redis Adapter 初始化失败: redis unavailable/,
  );

  assert.deepEqual(calls, [['configureRedisAdapter']]);
});

test('socketServerRuntime: logs Redis presence and adapter runtime modes on startup', async () => {
  const calls = [];
  const io = { id: 'io' };
  const httpServer = {
    listen(port, callback) {
      calls.push(['listen', port]);
      callback();
    },
  };

  await startSocketServer({
    httpServer,
    io,
    port: 9001,
    redirectURL: 'http://localhost:8080',
    logger: createFakeLogger(calls),
    configureRedisAdapter: async () => ({ enabled: true }),
    initializeOnlinePresence: () => {
      calls.push(['initializeOnlinePresence']);
    },
    onlinePresenceOptions: {
      presenceStoreOptions: {
        storeType: 'redis',
        keyPrefix: 'coderx',
      },
    },
  });

  const logMessages = calls.filter(([level]) => level === 'log').map(([, message]) => message);

  assert.ok(
    logMessages.includes('✅ Presence Store: redis（在线用户/连接记账写入 Redis，key 前缀 coderx:presence:*）'),
  );
  assert.ok(
    logMessages.includes(
      '✅ Socket.IO Redis Adapter: enabled（跨 Socket.IO 实例广播走 Redis Pub/Sub；单实例时主要是预备能力）',
    ),
  );
});

test('socketServerRuntime: close drains Socket.IO, presence, notifications and adapter once', async () => {
  const calls = [];
  const runtime = await startSocketServer({
    httpServer: { listen(_port, callback) { callback(); } },
    io: { async close() { calls.push('socket.io'); } },
    port: 0,
    logger: createFakeLogger([]),
    configureRedisAdapter: async () => ({ enabled: true, async close() { calls.push('adapter'); } }),
    initializeOnlinePresence: () => ({ async close() { calls.push('presence'); } }),
    notificationOptions: {},
    initializeNotifications: async () => ({ async close() { calls.push('notifications'); } }),
  });

  await Promise.all([runtime.close(), runtime.close()]);

  assert.equal(calls[0], 'socket.io');
  assert.deepEqual(calls.slice(1).sort(), ['adapter', 'notifications', 'presence']);
});

test('socketServerRuntime: notification startup failure releases earlier resources', async () => {
  const calls = [];
  await assert.rejects(() => startSocketServer({
    httpServer: { listen() { assert.fail('Must not listen on failed startup'); } },
    io: { async close() { calls.push('socket.io'); } },
    port: 0,
    configureRedisAdapter: async () => ({ enabled: true, async close() { calls.push('adapter'); } }),
    initializeOnlinePresence: () => ({ async close() { calls.push('presence'); } }),
    notificationOptions: {},
    initializeNotifications: async () => { throw new Error('subscription failed'); },
  }), /subscription failed/);

  assert.equal(calls[0], 'socket.io');
  assert.deepEqual(calls.slice(1).sort(), ['adapter', 'presence']);
});
