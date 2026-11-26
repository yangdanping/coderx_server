import type { MiddlewareHandler } from 'hono';
import type { AppEnv, HttpAppOptions } from '../http/types.js';
export function requestLogger(sink: HttpAppOptions['logRequest']): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    try {
      const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(c.req.method) ? c.req.method : 'OTHER';
      sink?.({ method, status: c.res.status, durationMs: Date.now() - start });
    } catch { /* Logging must not affect responses. */ }
  };
}
