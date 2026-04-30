const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

require('module-alias/register');

const { PRIVATE_KEY } = require('../../src/app/config');
const initSocketIOOnline = require('../../src/socket/online/socketio-online');

process.env.PRESENCE_STORE = 'memory';

function signToken(payload = { id: 7, name: 'Alice' }) {
  return jwt.sign(payload, PRIVATE_KEY, {
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

  async del(...keys) {
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
  initSocketIOOnline(io, {
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
  initSocketIOOnline(io);

  const socket = createFakeSocket({
    query: { userId: '7', userName: 'Alice', isGuest: 'false' },
  });

  const error = await connectFakeSocket(io, socket);

  assert.match(error.message, /Socket authentication required/);
  assert.equal(io.emitted.length, 0);
});

test('socketio-online: keeps authenticated users online when profile lookup fails', async () => {
  const io = createFakeIo();
  initSocketIOOnline(io, {
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
  initSocketIOOnline(io, {
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

  initSocketIOOnline(io, {
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

  initSocketIOOnline(io, {
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

test('socketio-online: can create a configured redis presence store from options', async () => {
  const io = createFakeIo();
  const redisClient = new FakeRedisClient();
  initSocketIOOnline(io, {
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
