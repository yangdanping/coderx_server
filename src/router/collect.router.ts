import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createCollectController } from '../controller/collect.controller.js';
import type { AppEnv } from '../http/types.js';

interface CollectRouteDependencies {
  service: Parameters<typeof createCollectController>[0];
  verifyAuth: MiddlewareHandler<AppEnv>;
  verifyPermission: MiddlewareHandler<AppEnv>;
}

export function registerCollectRoutes(app: Hono<AppEnv>, { service, verifyAuth, verifyPermission }: CollectRouteDependencies): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/collect');
    app.router.preserveLegacyParameterPath('/collect/:collectId');
    app.router.preserveLegacyParameterPath('/collect/:userId');
    app.router.preserveLegacyParameterPath('/collect/:collectId/articles');
  }
  const controller = createCollectController(service);
  app.post('/collect', verifyAuth, ...controller.addCollect);
  app.post('/collect/:collectId', verifyAuth, verifyPermission, ...controller.collectArticle);
  app.get('/collect/:userId', ...controller.getList);
  app.patch('/collect/:collectId', verifyAuth, verifyPermission, ...controller.updateCollect);
  app.delete('/collect/:collectId', verifyAuth, verifyPermission, ...controller.removeCollect);
  app.delete('/collect/:collectId/articles', verifyAuth, verifyPermission, ...controller.removeCollectArticle);
}
