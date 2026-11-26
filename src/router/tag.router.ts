import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createTagController } from '../controller/tag.controller.js';
import type { AppEnv } from '../http/types.js';

export function registerTagRoutes(
  app: Hono<AppEnv>,
  { service, verifyAuth }: { service: Parameters<typeof createTagController>[0]; verifyAuth: MiddlewareHandler<AppEnv> },
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/tag');
    app.router.preserveLegacyLiteralPath('/tag/order');
  }
  const controller = createTagController(service);
  app.post('/tag', verifyAuth, ...controller.addTag);
  app.get('/tag/order', verifyAuth, ...controller.getUserOrder);
  app.put('/tag/order', verifyAuth, ...controller.replaceUserOrder);
  app.get('/tag', ...controller.getList);
}
