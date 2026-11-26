import type { MiddlewareHandler, Context } from 'hono';
import { authUserId, type AppEnv } from '../http/types.js';
import { legacyJson } from '../http/legacyResponse.js';
import limits from '../constants/aiRateLimits.js';

// Each factory instance has its own in-memory budgets; processes do not share them.
// Node adapter supplies the direct peer. No forwarded header is trusted by default.
function peer(c: Context<AppEnv>): string {
  return c.env?.incoming?.socket?.remoteAddress || 'unknown';
}
export function createAiRateLimits(clock: () => number = Date.now) {
  const store = new Map<string, { count: number; resetAt: number }>();
  function limiter(bucket: 'chat' | 'completion', key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
      const id = `${bucket}:${key(c)}`;
      const now = clock();
      let record = store.get(id);
      if (!record || now >= record.resetAt) {
        record = { count: 0, resetAt: now + limits[bucket].windowMs };
        store.set(id, record);
      }
      if (record.count >= limits[bucket].maxRequests) {
        const failure = { msg: 'AI 请求过于频繁，请稍后再试', code: 429 };
        return bucket === 'chat' ? c.json(failure, 429) : legacyJson(c, failure, 429);
      }
      record.count++;
      await next();
    };
  }
  return { chat: limiter('chat', peer), completion: limiter('completion', c => String(authUserId(c.get('user')) || peer(c))) };
}
