const jwt = require('jsonwebtoken');

const { PUBLIC_KEY } = require('@/app/config');

function firstString(value) {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value : '';
}

function normalizeToken(rawToken) {
  const token = firstString(rawToken).trim();
  if (!token) return '';
  return token.startsWith('Bearer ') ? token.slice('Bearer '.length).trim() : token;
}

function getHandshakeToken(handshake = {}) {
  const auth = handshake.auth || {};
  const headers = handshake.headers || {};

  return normalizeToken(auth.token) || normalizeToken(auth.authorization) || normalizeToken(headers.authorization);
}

function hasClaimedIdentity(query = {}) {
  return Boolean(firstString(query.userId).trim() || firstString(query.userName).trim());
}

function authenticateSocketHandshake(handshake = {}) {
  const query = handshake.query || {};
  const token = getHandshakeToken(handshake);

  if (!token) {
    if (hasClaimedIdentity(query)) {
      throw new Error('Socket authentication required');
    }
    return { mode: 'guest' };
  }

  let payload;
  try {
    payload = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] });
  } catch {
    throw new Error('Socket authentication failed');
  }

  if (payload?.id == null || !payload?.name) {
    throw new Error('Socket authentication failed');
  }

  return {
    mode: 'user',
    userId: String(payload.id),
    userName: String(payload.name),
  };
}

module.exports = {
  authenticateSocketHandshake,
};
