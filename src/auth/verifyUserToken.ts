import type { KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

export type TokenVerificationKey = string | Buffer | KeyObject;

export function verifyUserToken(token: string, publicKey: TokenVerificationKey): unknown {
  return jwt.verify(token, publicKey, { algorithms: ['RS256'] });
}
