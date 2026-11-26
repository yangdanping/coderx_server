import type { MiddlewareHandler } from 'hono';
import { verifyUserToken, type TokenVerificationKey } from '../auth/verifyUserToken.js';
import { authUserId, type AppEnv, type AuthUser } from '../http/types.js';
import { LegacyEmittedError } from '../http/legacyError.js';
import { legacyJson } from '../http/legacyResponse.js';

export interface AuthDependencies {
  publicKey: TokenVerificationKey;
  checkStatus: (id: unknown) => Promise<unknown>;
  checkPermission: (table: string, dataId: string, userId: unknown) => Promise<unknown>;
}
function isAuthUser(value: unknown): value is AuthUser {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    || (typeof value === 'object' && value !== null);
}
export function createVerifyAuth(publicKey: AuthDependencies['publicKey']): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (!authorization) throw new LegacyEmittedError('未认证/token无效');
    let payload: unknown;
    try {
      payload = verifyUserToken(authorization.replace('Bearer ', ''), publicKey);
    } catch {
      throw new LegacyEmittedError('未认证/token无效');
    }
    // The JWT type header can decode JSON scalars too; claim presence is not authentication.
    if (!isAuthUser(payload)) throw new LegacyEmittedError('未认证/token无效');
    c.set('user', payload);
    await next();
  };
}
export function createAuthMiddleware({ publicKey, checkStatus, checkPermission }: AuthDependencies) {
  const verifyAuth = createVerifyAuth(publicKey);
  const verifyStatus: MiddlewareHandler<AppEnv> = async (c, next) => {
    const status = await checkStatus(authUserId(c.get('user')));
    if (status) return legacyJson(c, { msg: '您已被封禁', code: -1 });
    await next();
  };
  const verifyPermission: MiddlewareHandler<AppEnv> = async (c, next) => {
    const params: Record<string, string> = c.req.param();
    const [key] = Object.keys(params);
    const table = key.replace('Id', '');
    try {
      const permitted = await checkPermission(table, params[key], authUserId(c.get('user')));
      if (!permitted) throw new Error('Permission denied');
    } catch {
      throw new LegacyEmittedError('不具备操作的权限');
    }
    await next();
  };
  return { verifyAuth, verifyStatus, verifyPermission };
}
