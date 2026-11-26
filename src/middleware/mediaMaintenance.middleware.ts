import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../http/types.js';
import { legacyJson } from '../http/legacyResponse.js';
export function mediaMutationMaintenance(isPaused: () => boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isPaused()) return legacyJson(c, { msg: '媒体上传和文章发布正在进行短时维护，请稍后重试', code: 503 }, 503);
    await next();
  };
}
