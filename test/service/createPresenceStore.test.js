const test = require('node:test');
const assert = require('node:assert/strict');

const { createConfiguredPresenceStore, createPresenceStore } = require('../../src/socket/createPresenceStore');

class FakeRedisClient {
  constructor() {
    this.sets = new Map();
    this.hashes = new Map();
  }

  async sAdd(key, value) {
    const set = this.sets.get(key) || new Set();
    const sizeBefore = set.size;
    set.add(String(value));
    this.sets.set(key, set);
    return set.size - sizeBefore;
  }

  async sRem(key, value) {
    const set = this.sets.get(key);
    if (!set) return 0;
    const removed = set.delete(String(value)) ? 1 : 0;
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  async sCard(key) {
    return this.sets.get(key)?.size || 0;
  }

  async sMembers(key) {
    return Array.from(this.sets.get(key) || []);
  }

  async hSet(key, values) {
    const hash = this.hashes.get(key) || {};
    Object.assign(hash, Object.fromEntries(Object.entries(values).map(([field, value]) => [field, String(value)])));
    this.hashes.set(key, hash);
    return Object.keys(values).length;
  }

  async hGetAll(key) {
    return { ...(this.hashes.get(key) || {}) };
  }

  async expire() {
    return 1;
  }

  async del(...keys) {
    for (const key of keys) {
      this.sets.delete(key);
      this.hashes.delete(key);
    }
    return keys.length;
  }
}

test('createPresenceStore: defaults to memory presence when no store type is configured', () => {
  const previous = process.env.PRESENCE_STORE;
  delete process.env.PRESENCE_STORE;

  try {
    const presence = createPresenceStore();
    const result = presence.addConnection({
      userId: '1',
      socketId: 's1',
      userName: 'alice',
      avatarUrl: '',
    });

    assert.equal(result.isFirstSocket, true);
    assert.equal(presence.size(), 1);
    assert.equal(presence.totalConnections(), 1);
    assert.equal(presence.serializeUserList()[0].userId, '1');
  } finally {
    if (previous === undefined) {
      delete process.env.PRESENCE_STORE;
    } else {
      process.env.PRESENCE_STORE = previous;
    }
  }
});

test('createPresenceStore: supports explicit memory store type', () => {
  const presence = createPresenceStore({ storeType: 'memory' });

  presence.addConnection({
    userId: '2',
    socketId: 's2',
    userName: 'bob',
    avatarUrl: '',
  });

  assert.deepEqual(
    presence.serializeUserList().map((user) => user.userName),
    ['bob'],
  );
});

test('createPresenceStore: supports redis store type when a redis client is injected', async () => {
  const presence = createPresenceStore({
    storeType: 'redis',
    redisClient: new FakeRedisClient(),
    keyPrefix: 'coderx',
  });

  const result = await presence.addConnection({
    userId: '3',
    socketId: 's3',
    userName: 'carol',
    avatarUrl: '',
  });

  assert.deepEqual(result, { isFirstSocket: true, userConnectionCount: 1 });
  assert.equal(await presence.size(), 1);
  assert.equal((await presence.serializeUserList())[0].userName, 'carol');
});

test('createPresenceStore: rejects redis store type without a redis client', () => {
  assert.throws(
    () => createPresenceStore({ storeType: 'redis' }),
    /redisPresenceStore requires a redisClient/,
  );
});

test('createPresenceStore: rejects unsupported store types with a clear message', () => {
  assert.throws(
    () => createPresenceStore({ storeType: 'postgres' }),
    /Unsupported PRESENCE_STORE "postgres"\. Supported values: memory, redis/,
  );
});

test('createConfiguredPresenceStore: creates a redis client when redis is selected without an injected client', async () => {
  const calls = [];
  const client = new FakeRedisClient();
  client.on = () => client;
  client.connect = async () => {
    calls.push(['connect']);
    return client;
  };

  const redis = {
    createClient(options) {
      calls.push(['createClient', options]);
      return client;
    },
  };

  const presence = await createConfiguredPresenceStore({
    storeType: 'redis',
    redis,
    redisUrl: 'redis://docker-redis:6379/0',
  });

  await presence.addConnection({ userId: '4', socketId: 's4', userName: 'dave' });

  assert.deepEqual(calls, [['createClient', { url: 'redis://docker-redis:6379/0' }], ['connect']]);
  assert.equal(await presence.size(), 1);
  assert.equal((await presence.serializeUserList())[0].userName, 'dave');
});
