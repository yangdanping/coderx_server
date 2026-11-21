import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { generateKeyPairSync } from 'node:crypto';
import { createSocketAuthenticator } from '../../src/socket/auth/socketAuth.factory.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const authenticateSocketHandshake = createSocketAuthenticator({ publicKey });

import initialize from '../../src/socket/online/socketio-online.js';

function initializeOnlinePresence(io, options) {
  return initialize(io, {
    authenticateSocketHandshake,
    userService: { getProfileById: async () => undefined },
    presenceStoreOptions: { storeType: 'memory' },
    logger: { log() {}, warn() {}, error() {} },
    ...options,
  });
}

function signToken(payload = { id: 7, name: 'Alice' }) {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: '1h',
    allowInsecureKeySizes: true,
  });
}

function createFakeIo() {
  return {
    middlewares: [],
    handlers: {},
    emitted: [],
    use(fn) {
      this.middlewares.push(fn);
    },
    on(event, handler) {
      this.handlers[event] = handler;
    },
    off(event, handler) {
      if (this.handlers[event] === handler) delete this.handlers[event];
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
  };
}

function createFakeSocket({ id = 's1', auth = {}, query = {} } = {}) {
  return {
    id,
    handshake: { auth, query, headers: {} },
    data: {},
    handlers: {},
    emitted: [],
    on(event, handler) {
      this.handlers[event] = handler;
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
  };
}

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

  async del(keys) {
    keys = [keys].flat();
    for (const key of keys) {
      this.sets.delete(key);
      this.hashes.delete(key);
    }
    return keys.length;
  }
}

async function connectFakeSocket(io, socket) {
  for (const middleware of io.middlewares) {
    let middlewareError;
    await new Promise((resolve) => {
      middleware(socket, (error) => {
        middlewareError = error;
        resolve();
      });
    });
    if (middlewareError) return middlewareError;
  }

  await io.handlers.connection(socket);
  return undefined;
}

test('socketio-online: registers authenticated users from JWT payload instead of query identity', async () => {
  const io = createFakeIo();
  initializeOnlinePresence(io, {
    userService: {
      getProfileById: async () => ({ avatarUrl: 'https://cdn.example/server-alice.png' }),
    },
  });

  const socket = createFakeSocket({
    auth: { token: signToken(), avatarUrl: 'https://cdn.example/client-alice.png' },
    query: {
      userId: '999',
      userName: 'Mallory',
      avatarUrl: 'https://cdn.example/mallory.png',
      isGuest: 'false',
    },
  });

  const error = await connectFakeSocket(io, socket);

  assert.equal(error, undefined);
  assert.deepEqual(io.emitted.at(-1), {
    event: 'online',
    payload: {
      userList: [
        {
          userId: '7',
          userName: 'Alice',
          avatarUrl: 'https://cdn.example/server-alice.png',
          status: 'online',
          connectedAt: io.emitted.at(-1).payload.userList[0].connectedAt,
        },
      ],
    },
  });
});

test('socketio-online: rejects claimed user identity when token is missing', async () => {
  const io = createFakeIo();
  initializeOnlinePresence(io);

  const socket = createFakeSocket({
    query: { userId: '7', userName: 'Alice', isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);

  assert.match(error.message, /Socket authentication required/);
  assert.equal(io.emitted.length, 0);
});

test('socketio-online: keeps authenticated users online when profile lookup fails', async () => {
  const io = createFakeIo();
  initializeOnlinePresence(io, {
    userService: {
      getProfileById: async () => {
        throw new Error('database unavailable');
      },
    },
  });

  const socket = createFakeSocket({
    auth: { token: signToken() },
    query: { isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);

  assert.equal(error, undefined);
  assert.equal(io.emitted.at(-1).payload.userList[0].userId, '7');
  assert.equal(io.emitted.at(-1).payload.userList[0].avatarUrl, '');
});

test('socketio-online: profile lookup timeout falls back to empty avatar', async () => {
  const io = createFakeIo();
  initializeOnlinePresence(io, {
    profileLookupTimeoutMs: 1,
    userService: {
      getProfileById: () => new Promise((resolve) => setTimeout(() => resolve({ avatarUrl: 'late-avatar' }), 50)),
    },
  });

  const socket = createFakeSocket({
    auth: { token: signToken() },
    query: { isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);

  assert.equal(error, undefined);
  assert.equal(io.emitted.at(-1).payload.userList[0].avatarUrl, '');
});

test('socketio-online: can use an injected presence store without knowing its implementation', async () => {
  const io = createFakeIo();
  const calls = [];
  const injectedPresenceStore = {
    async addConnection(payload) {
      calls.push(['addConnection', payload]);
      return { isFirstSocket: true, userConnectionCount: 1 };
    },
    async removeConnection(payload) {
      calls.push(['removeConnection', payload]);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    },
    async serializeUserList() {
      return [
        {
          userId: '7',
          userName: 'Alice',
          avatarUrl: 'from-injected-store',
          status: 'online',
          connectedAt: '2026-04-25T00:00:00.000Z',
        },
      ];
    },
    async size() {
      return 1;
    },
    async totalConnections() {
      return 1;
    },
  };

  initializeOnlinePresence(io, {
    presenceStore: injectedPresenceStore,
    userService: {
      getProfileById: async () => ({ avatarUrl: 'profile-avatar' }),
    },
  });

  const socket = createFakeSocket({
    auth: { token: signToken() },
    query: { isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);

  assert.equal(error, undefined);
  assert.deepEqual(calls[0], [
    'addConnection',
    {
      userId: '7',
      socketId: 's1',
      userName: 'Alice',
      avatarUrl: 'profile-avatar',
    },
  ]);
  assert.deepEqual(io.emitted.at(-1).payload.userList, [
    {
      userId: '7',
      userName: 'Alice',
      avatarUrl: 'from-injected-store',
      status: 'online',
      connectedAt: '2026-04-25T00:00:00.000Z',
    },
  ]);
});

test('socketio-online: waits for async presence removal before broadcasting disconnect', async () => {
  const io = createFakeIo();
  const calls = [];
  let isOnline = true;
  const injectedPresenceStore = {
    async addConnection(payload) {
      calls.push(['addConnection', payload]);
      return { isFirstSocket: true, userConnectionCount: 1 };
    },
    async removeConnection(payload) {
      await new Promise((resolve) => setImmediate(resolve));
      isOnline = false;
      calls.push(['removeConnection', payload]);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    },
    async serializeUserList() {
      if (!isOnline) return [];
      return [
        {
          userId: '7',
          userName: 'Alice',
          avatarUrl: 'avatar',
          status: 'online',
          connectedAt: '2026-04-25T00:00:00.000Z',
        },
      ];
    },
    async size() {
      return isOnline ? 1 : 0;
    },
    async totalConnections() {
      return isOnline ? 1 : 0;
    },
  };

  initializeOnlinePresence(io, {
    presenceStore: injectedPresenceStore,
    userService: {
      getProfileById: async () => ({ avatarUrl: 'avatar' }),
    },
  });

  const socket = createFakeSocket({
    auth: { token: signToken() },
    query: { isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);
  assert.equal(error, undefined);
  assert.equal(io.emitted.at(-1).payload.userList.length, 1);

  await socket.handlers.disconnect('transport close');

  assert.deepEqual(calls.at(-1), ['removeConnection', { userId: '7', socketId: 's1' }]);
  assert.deepEqual(io.emitted.at(-1), {
    event: 'online',
    payload: {
      userList: [],
    },
  });
});

test('socketio-online: refreshes authenticated presence while socket stays connected', async () => {
  const io = createFakeIo();
  const calls = [];
  const intervals = [];
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  global.setInterval = (callback, delay) => {
    const interval = { callback, delay, cleared: false };
    intervals.push(interval);
    return interval;
  };
  global.clearInterval = (interval) => {
    interval.cleared = true;
  };

  const injectedPresenceStore = {
    async addConnection(payload) {
      calls.push(['addConnection', payload]);
      return { isFirstSocket: true, userConnectionCount: 1 };
    },
    async refreshConnection(payload) {
      calls.push(['refreshConnection', payload]);
      return true;
    },
    async removeConnection(payload) {
      calls.push(['removeConnection', payload]);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    },
    async serializeUserList() {
      return [];
    },
    async size() {
      return 1;
    },
    async totalConnections() {
      return 1;
    },
  };

  try {
    initializeOnlinePresence(io, {
      presenceStore: injectedPresenceStore,
      presenceRefreshIntervalMs: 1000,
      userService: {
        getProfileById: async () => ({ avatarUrl: '' }),
      },
    });

    const socket = createFakeSocket({
      auth: { token: signToken() },
      query: { isGuest: 'false' },
    });

    const error = await connectFakeSocket(io, socket);
    assert.equal(error, undefined);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].delay, 1000);

    await intervals[0].callback();
    assert.deepEqual(calls.at(-1), ['refreshConnection', { userId: '7', socketId: 's1' }]);

    await socket.handlers.disconnect('transport close');
    assert.equal(intervals[0].cleared, true);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('socketio-online: refresh interval accepts synchronous presence stores', async () => {
  const io = createFakeIo();
  const calls = [];
  const intervals = [];
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  global.setInterval = (callback, delay) => {
    const interval = { callback, delay, cleared: false };
    intervals.push(interval);
    return interval;
  };
  global.clearInterval = (interval) => {
    interval.cleared = true;
  };

  const injectedPresenceStore = {
    addConnection(payload) {
      calls.push(['addConnection', payload]);
      return { isFirstSocket: true, userConnectionCount: 1 };
    },
    refreshConnection(payload) {
      calls.push(['refreshConnection', payload]);
      return true;
    },
    removeConnection(payload) {
      calls.push(['removeConnection', payload]);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    },
    serializeUserList() {
      return [];
    },
    size() {
      return 1;
    },
    totalConnections() {
      return 1;
    },
  };

  try {
    initializeOnlinePresence(io, {
      presenceStore: injectedPresenceStore,
      presenceRefreshIntervalMs: 1000,
      userService: {
        getProfileById: async () => ({ avatarUrl: '' }),
      },
    });

    const socket = createFakeSocket({
      auth: { token: signToken() },
      query: { isGuest: 'false' },
    });

    const error = await connectFakeSocket(io, socket);
    assert.equal(error, undefined);
    assert.equal(intervals.length, 1);

    await assert.doesNotReject(() => Promise.resolve(intervals[0].callback()));
    assert.deepEqual(calls.at(-1), ['refreshConnection', { userId: '7', socketId: 's1' }]);

    await socket.handlers.disconnect('transport close');
    assert.equal(intervals[0].cleared, true);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('socketio-online: can create a configured redis presence store from options', async () => {
  const io = createFakeIo();
  const redisClient = new FakeRedisClient();
  initializeOnlinePresence(io, {
    presenceStoreOptions: {
      storeType: 'redis',
      redisClient,
      keyPrefix: 'coderx-test',
    },
    userService: {
      getProfileById: async () => ({ avatarUrl: 'redis-avatar' }),
    },
  });

  const socket = createFakeSocket({
    auth: { token: signToken() },
    query: { isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);

  assert.equal(error, undefined);
  assert.equal(io.emitted.at(-1).payload.userList[0].userId, '7');
  assert.equal(io.emitted.at(-1).payload.userList[0].avatarUrl, 'redis-avatar');
  assert.deepEqual(Array.from(redisClient.sets.get('coderx-test:presence:users')), ['7']);
});

test('socketio-online: drains a Redis registration when the socket disconnects before it finishes', async () => {
  const io = createFakeIo();
  const calls = [];
  let added;
  const waitingForAdd = new Promise(resolve => { added = resolve; });
  let finishAdd;
  const inFlightAdd = new Promise(resolve => { finishAdd = resolve; });
  const runtime = initializeOnlinePresence(io, {
    presenceStore: {
      async addConnection() {
        added();
        await inFlightAdd;
        calls.push('added');
        return { isFirstSocket: true, userConnectionCount: 1 };
      },
      removeConnection() {
        calls.push('removed');
        return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
      },
      serializeUserList: () => [],
      size: () => 0,
      totalConnections: () => 0,
    },
  });
  const socket = createFakeSocket({ auth: { token: signToken() } });
  const accepting = connectFakeSocket(io, socket);
  await waitingForAdd;

  const disconnected = socket.handlers.disconnect('transport close');
  const closing = runtime.close();
  assert.deepEqual(calls, []);
  finishAdd();
  await Promise.all([accepting, disconnected, closing]);

  assert.deepEqual(calls, ['added', 'removed']);
  assert.equal(io.handlers.connection, undefined);
});
