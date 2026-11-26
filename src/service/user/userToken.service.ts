import type { KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

export type TokenUser = { id: number | string; name: string };
type TokenKey = string | Buffer | KeyObject;
export function createSignUserToken(privateKey: TokenKey) {
  return ({ id, name }: TokenUser) => jwt.sign({ id, name }, privateKey, {
    expiresIn: 7 * 24 * 60 * 60,
    algorithm: 'RS256',
    allowInsecureKeySizes: true,
  });
}
