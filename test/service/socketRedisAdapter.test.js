const test = require('node:test');
const assert = require('node:assert/strict');

const { configureSocketRedisAdapter } = require('../../src/socket/socketRedisAdapter');

function createFakeIo() {
  const calls = [];

  return {
    calls,
    adapter(adapterInstance) {
      calls.push(['io.adapter', adapterInstance]);
    },
  };
}

function createFakeRedis({ failOnConnectClient } = {}) {
  const calls = [];
  const clients = {};

  function createClient(name) {
    return {
      name,
      handlers: {},
      on(event, handler) {
        this.handlers[event] = handler;
        calls.push(['on', name, event]);
        return this;
      },
      duplicate() {
        calls.push(['duplicate', name]);
        clients.sub = createClient('sub');
        return clients.sub;
      },
      async connect() {
        calls.push(['connect', name]);
        if (failOnConnectClient === name) {
          throw new Error(`${name} connect failed`);
        }
      },
      async quit() {
        calls.push(['quit', name]);
      },
    };
  }

  const redis = {
    createClient(options) {
      calls.push(['createClient', options]);
      clients.pub = createClient('pub');
      return clients.pub;
    },
  };

  return { calls, clients, redis };
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
}

test('socketRedisAdapter: default disabled mode does not create Redis clients or install adapter', async () => {
  await withEnv('SOCKET_REDIS_ADAPTER_ENABLED', undefined, async () => {
    const io = createFakeIo();
    const fakeRedis = createFakeRedis();
    const adapterCalls = [];

    const result = await configureSocketRedisAdapter(io, {
      redis: fakeRedis.redis,
      createAdapter(pubClient, subClient) {
        adapterCalls.push(['createAdapter', pubClient.name, subClient.name]);
        return { type: 'redis-adapter' };
      },
    });

    assert.deepEqual(result, { enabled: false });
    assert.deepEqual(fakeRedis.calls, []);
    assert.deepEqual(adapterCalls, []);
    assert.deepEqual(io.calls, []);
  });
});

test('socketRedisAdapter: enabled mode creates pub/sub clients and installs Redis adapter', async () => {
  const io = createFakeIo();
  const fakeRedis = createFakeRedis();
  const adapterInstance = { type: 'redis-adapter' };
  const adapterCalls = [];

  const result = await configureSocketRedisAdapter(io, {
    enabled: true,
    redis: fakeRedis.redis,
    redisUrl: 'redis://adapter-redis:6379/0',
    createAdapter(pubClient, subClient) {
      adapterCalls.push(['createAdapter', pubClient.name, subClient.name]);
      return adapterInstance;
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.pubClient.name, 'pub');
  assert.equal(result.subClient.name, 'sub');
  assert.deepEqual(fakeRedis.calls, [
    ['createClient', { url: 'redis://adapter-redis:6379/0' }],
    ['on', 'pub', 'error'],
    ['duplicate', 'pub'],
    ['on', 'sub', 'error'],
    ['connect', 'pub'],
    ['connect', 'sub'],
  ]);
  assert.deepEqual(adapterCalls, [['createAdapter', 'pub', 'sub']]);
  assert.deepEqual(io.calls, [['io.adapter', adapterInstance]]);
});

test('socketRedisAdapter: Redis connection failure surfaces a clear startup error', async () => {
  const io = createFakeIo();
  const fakeRedis = createFakeRedis({ failOnConnectClient: 'sub' });

  await assert.rejects(
    () =>
      configureSocketRedisAdapter(io, {
        enabled: true,
        redis: fakeRedis.redis,
        redisUrl: 'redis://adapter-redis:6379/0',
        createAdapter() {
          return { type: 'redis-adapter' };
        },
      }),
    /Socket\.IO Redis Adapter 初始化失败: sub connect failed/,
  );

  assert.deepEqual(io.calls, []);
});
