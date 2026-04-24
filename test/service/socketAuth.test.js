const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

require('module-alias/register');

const { PRIVATE_KEY } = require('../../src/app/config');
const { authenticateSocketHandshake } = require('../../src/socket/socketAuth');

function signToken(payload = { id: 7, name: 'Alice' }) {
  return jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    expiresIn: '1h',
    allowInsecureKeySizes: true,
  });
}

test('socketAuth: valid JWT is the only source of user identity even when client fields are forged', () => {
  const auth = authenticateSocketHandshake({
    auth: {
      token: signToken(),
      avatarUrl: 'https://cdn.example/alice.png',
    },
    query: {
      isGuest: 'false',
      userId: '999',
      userName: 'Mallory',
      avatarUrl: 'https://cdn.example/mallory.png',
    },
  });

  assert.deepEqual(auth, {
    mode: 'user',
    userId: '7',
    userName: 'Alice',
  });
});

test('socketAuth: guest handshakes without claimed identity are allowed as observers', () => {
  const auth = authenticateSocketHandshake({
    auth: {},
    query: { isGuest: 'true' },
  });

  assert.deepEqual(auth, { mode: 'guest' });
});

test('socketAuth: missing token with claimed user identity is rejected', () => {
  assert.throws(
    () =>
      authenticateSocketHandshake({
        auth: {},
        query: { userId: '7', userName: 'Alice', isGuest: 'false' },
      }),
    /Socket authentication required/,
  );
});

test('socketAuth: invalid token is rejected', () => {
  assert.throws(
    () =>
      authenticateSocketHandshake({
        auth: { token: 'not-a-jwt' },
        query: { isGuest: 'false' },
      }),
    /Socket authentication failed/,
  );
});
