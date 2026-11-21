import type { Hono } from 'hono';
import type { AppEnv } from './types.js';
import { checkReadiness } from './dependencies.js';
import type { HttpAppOptions } from './types.js';
export function registerHealthRoutes(app: Hono<AppEnv>, options: HttpAppOptions): void {
  app.get('/health/live', c => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok', buildId: options.buildId });
  });
  app.get('/health/ready', async c => {
    c.header('Cache-Control', 'no-store');
    const ready = await checkReadiness(options.checkReady, options.readinessTimeoutMs ?? 1000);
    return c.json({ status: ready ? 'ok' : 'unavailable', buildId: options.buildId }, ready ? 200 : 503);
  });
}

import type { Handler } from 'hono';
const strictHandlers = new WeakSet<object>();
/** Register a constrained route whose trailing slash is significant. */
export function registerStrictRoute<P extends string>(app: Hono<AppEnv>, method: string, path: P, handler: Handler<AppEnv, P>): void {
  // A fresh wrapper marks this registration only, even if a caller reuses its handler.
  const registered: Handler<AppEnv, P> = (c, next) => handler(c, next);
  strictHandlers.add(registered);
  app.on(method, path, registered);
}
export function isStrictHandler(handler: object): boolean {
  return strictHandlers.has(handler);
}
