import { Hono } from 'hono';
import { errorHandler } from '../middleware/error.middleware.js';
import { requestLogger } from '../middleware/logger.middleware.js';
import { bodyParser } from '../middleware/bodyParser.middleware.js';
import { registerHealthRoutes } from './registerRoutes.js';
import { CompatibilityRouter, rawRequestPath } from './compatibility.router.js';
import { legacyText } from './legacyResponse.js';
import type { AppEnv, HttpAppOptions } from './types.js';
export type { AppEnv, AuthUser, HttpAppOptions } from './types.js';

const legacyImplementedMethods = new Set(['HEAD', 'OPTIONS', 'GET', 'PUT', 'PATCH', 'POST', 'DELETE']);

export function createHttpApp(options: HttpAppOptions): Hono<AppEnv> {
  const router = new CompatibilityRouter();
  const app = new Hono<AppEnv>({ router, getPath: (request, options) => router.getPath(request, options?.env) });
  app.use('*', requestLogger(options.logRequest));
  app.use('*', async (c, next) => {
    c.header('Vary', 'Origin', { append: true });
    const origin = c.req.header('Origin');
    const allowed = options.allowedOrigins ?? [];
    const selected = origin && allowed.includes(origin) ? origin : allowed[0];
    if (selected && (c.req.method !== 'OPTIONS' || c.req.header('Access-Control-Request-Method'))) {
      c.header('Access-Control-Allow-Origin', selected);
      c.header('Access-Control-Allow-Credentials', 'true');
      if (c.req.method === 'OPTIONS') {
        c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
        c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept');
        return c.body(null, 204);
      }
    }
    await next();
  });
  app.use('*', bodyParser);
  app.onError(errorHandler(options.developmentErrors ?? false));
  registerHealthRoutes(app, options);
  options.registerRoutes(app);
  app.notFound(c => {
    const rawPath = rawRequestPath(c.req.raw, c.env);
    const methods = router.allowedMethods(c.req.path, rawPath);
    if (!methods.length || methods.includes(c.req.method) || (c.req.method === 'HEAD' && methods.includes('GET'))) return legacyText(c, 'Not Found', 404);
    c.header('Allow', methods.join(', '));
    if (router.isLegacyPath(rawPath)) {
      if (c.req.method === 'HEAD') return c.body(null, 405);
      if (!legacyImplementedMethods.has(c.req.method)) return legacyText(c, 'Not Implemented', 501);
      return c.req.method === 'OPTIONS' ? legacyText(c, '', 200) : legacyText(c, 'Method Not Allowed', 405);
    }
    return c.req.method === 'OPTIONS' ? c.body(null, 200) : c.text('Method Not Allowed', 405);
  });
  return app;
}
