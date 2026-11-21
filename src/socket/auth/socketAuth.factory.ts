import { verifyUserToken, type TokenVerificationKey } from '../../auth/verifyUserToken.js';

interface SocketHandshake {
  auth?: { token?: unknown; authorization?: unknown };
  headers?: { authorization?: unknown };
  query?: { userId?: unknown; userName?: unknown } & Record<string, unknown>;
}

export type GuestPresence = { mode: 'guest' };
export type UserPresence = { mode: 'user'; userId: string; userName: string; avatarUrl?: string };
export type PresenceAuth = GuestPresence | UserPresence;

function firstString(value: unknown): string {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value : '';
}

function normalizeToken(rawToken: unknown) {
  const token = firstString(rawToken).trim();
  return token.startsWith('Bearer ') ? token.slice('Bearer '.length).trim() : token;
}

export function createSocketAuthenticator({ publicKey, verify = verifyUserToken }: {
  publicKey: TokenVerificationKey;
  verify?: (token: string, publicKey: TokenVerificationKey, options: { algorithms: ['RS256'] }) => unknown;
}) {
  return function authenticateSocketHandshake(handshake: SocketHandshake = {}): PresenceAuth {
    const { auth, headers, query } = handshake;
    const token = normalizeToken(auth?.token) || normalizeToken(auth?.authorization) || normalizeToken(headers?.authorization);
    if (!token) {
      if (firstString(query?.userId).trim() || firstString(query?.userName).trim()) {
        throw new Error('Socket authentication required');
      }
      return { mode: 'guest' };
    }

    let payload: unknown;
    try {
      payload = verify(token, publicKey, { algorithms: ['RS256'] });
    } catch {
      throw new Error('Socket authentication failed');
    }

    if (typeof payload !== 'object' || payload === null || !('id' in payload) || payload.id == null ||
      !('name' in payload) || !payload.name) {
      throw new Error('Socket authentication failed');
    }

    return { mode: 'user', userId: String(payload.id), userName: String(payload.name) };
  };
}

export type SocketAuthenticator = ReturnType<typeof createSocketAuthenticator>;
