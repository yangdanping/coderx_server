const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_REDIS_URL, createPresenceRedisClient } = require('../../src/socket/redisClient');

function createFakeRedis() {
  const calls = [];
  const client = {
    handlers: {},
    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    },
    async connect() {
      calls.push(['connect']);
      return this;
    },
  };

  return {
    calls,
    client,
    redis: {
      createClient(options) {
        calls.push(['createClient', options]);
        return client;
      },
    },
  };
}

test('redisClient: connects with the default Redis URL when no URL is configured', async () => {
  const previous = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const fake = createFakeRedis();

  try {
    const client = await createPresenceRedisClient({ redis: fake.redis });

    assert.equal(client, fake.client);
    assert.deepEqual(fake.calls, [['createClient', { url: DEFAULT_REDIS_URL }], ['connect']]);
    assert.equal(typeof fake.client.handlers.error, 'function');
  } finally {
    if (previous === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previous;
    }
  }
});

test('redisClient: explicit URL overrides REDIS_URL', async () => {
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://env-redis:6379/0';
  const fake = createFakeRedis();

  try {
    await createPresenceRedisClient({
      redis: fake.redis,
      url: 'redis://explicit-redis:6379/1',
    });

    assert.deepEqual(fake.calls[0], ['createClient', { url: 'redis://explicit-redis:6379/1' }]);
  } finally {
    if (previous === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previous;
    }
  }
});

test('redisClient: logs client error events without throwing from the handler', async () => {
  const fake = createFakeRedis();
  const logs = [];
  const logger = {
    error(...args) {
      logs.push(args);
    },
  };

  const client = await createPresenceRedisClient({ redis: fake.redis, logger });
  client.handlers.error(new Error('connection lost'));

  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /Redis 连接错误/);
  assert.match(logs[0][1].message, /connection lost/);
});
