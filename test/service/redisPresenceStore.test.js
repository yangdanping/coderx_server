const test = require('node:test');
const assert = require('node:assert/strict');

const { createRedisPresenceStore } = require('../../src/socket/redisPresenceStore');

class FakeRedisClient {
  constructor() {
    this.sets = new Map();
    this.hashes = new Map();
    this.expireCalls = [];
    this.deletedKeys = [];
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

  async expire(key, seconds) {
    this.expireCalls.push({ key, seconds });
    return 1;
  }

  async del(...keys) {
    let deleted = 0;
    for (const key of keys) {
      this.deletedKeys.push(key);
      if (this.sets.delete(key)) deleted += 1;
      if (this.hashes.delete(key)) deleted += 1;
    }
    return deleted;
  }
}

test('redisPresenceStore: stores one online user with stable DTO shape and socket TTL', async () => {
  const redisClient = new FakeRedisClient();
  const presence = createRedisPresenceStore({ redisClient, keyPrefix: 'coderx', socketTtlSeconds: 90 });

  const result = await presence.addConnection({
    userId: '7',
    socketId: 's1',
    userName: 'Alice',
    avatarUrl: 'https://cdn.example/alice.png',
  });

  assert.deepEqual(result, { isFirstSocket: true, userConnectionCount: 1 });
  assert.equal(await presence.size(), 1);
  assert.equal(await presence.totalConnections(), 1);
  assert.deepEqual(await presence.serializeUserList(), [
    {
      userId: '7',
      userName: 'Alice',
      avatarUrl: 'https://cdn.example/alice.png',
      status: 'online',
      connectedAt: (await presence.serializeUserList())[0].connectedAt,
    },
  ]);
  assert.deepEqual(redisClient.expireCalls, [{ key: 'coderx:presence:socket:s1', seconds: 90 }]);
});

test('redisPresenceStore: keeps user online until the last socket disconnects', async () => {
  const redisClient = new FakeRedisClient();
  const presence = createRedisPresenceStore({ redisClient });

  await presence.addConnection({ userId: '7', socketId: 's1', userName: 'Alice' });
  const second = await presence.addConnection({ userId: '7', socketId: 's2', userName: 'Alice' });

  assert.deepEqual(second, { isFirstSocket: false, userConnectionCount: 2 });
  assert.equal(await presence.size(), 1);
  assert.equal(await presence.totalConnections(), 2);

  const firstDisconnect = await presence.removeConnection({ userId: '7', socketId: 's1' });

  assert.deepEqual(firstDisconnect, { removedUser: false, hadEntry: true, userConnectionCount: 1 });
  assert.equal((await presence.serializeUserList()).length, 1);

  const lastDisconnect = await presence.removeConnection({ userId: '7', socketId: 's2' });

  assert.deepEqual(lastDisconnect, { removedUser: true, hadEntry: true, userConnectionCount: 0 });
  assert.equal(await presence.size(), 0);
  assert.deepEqual(await presence.serializeUserList(), []);
});

test('redisPresenceStore: removeConnection is safe for unknown users', async () => {
  const presence = createRedisPresenceStore({ redisClient: new FakeRedisClient() });

  assert.deepEqual(await presence.removeConnection({ userId: '404', socketId: 'missing' }), {
    removedUser: false,
    hadEntry: false,
    userConnectionCount: 0,
  });
});

test('redisPresenceStore: counts connections across multiple users', async () => {
  const presence = createRedisPresenceStore({ redisClient: new FakeRedisClient() });

  await presence.addConnection({ userId: '1', socketId: 'a', userName: 'u1' });
  await presence.addConnection({ userId: '1', socketId: 'b', userName: 'u1' });
  await presence.addConnection({ userId: '2', socketId: 'c', userName: 'u2' });

  assert.equal(await presence.size(), 2);
  assert.equal(await presence.totalConnections(), 3);
  assert.deepEqual(
    (await presence.serializeUserList()).map((user) => user.userId),
    ['1', '2'],
  );
});
