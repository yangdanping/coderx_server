const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

require('module-alias/register');

const { PRIVATE_KEY } = require('../../src/app/config');
const initSocketIOOnline = require('../../src/socket/socketio-online');

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

  io.handlers.connection(socket);
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
