const test = require('node:test');
const assert = require('node:assert/strict');

const { startSocketServer } = require('../../src/socket/socketServerRuntime');

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
    initOnline: (receivedIo) => {
      calls.push(['initOnline', receivedIo]);
    },
  });

  assert.equal(result.httpServer, httpServer);
  assert.equal(result.io, io);
  assert.deepEqual(calls.slice(0, 3), [
    ['configureRedisAdapter', io],
    ['initOnline', io],
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
        initOnline: () => {
          calls.push(['initOnline']);
        },
      }),
    /Socket\.IO Redis Adapter 初始化失败: redis unavailable/,
  );

  assert.deepEqual(calls, [['configureRedisAdapter']]);
});
