import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createHistoryController } from '../controller/history.controller.js';
import type { AppEnv } from '../http/types.js';

export function registerHistoryRoutes(
  app: Hono<AppEnv>,
  { service, verifyAuth }: { service: Parameters<typeof createHistoryController>[0]; verifyAuth: MiddlewareHandler<AppEnv> },
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/history');
    app.router.preserveLegacyParameterPath('/history/:articleId');
    app.router.preserveLegacyParameterPath('/history/:articleId/check');
  }
  const controller = createHistoryController(service);
  app.post('/history', verifyAuth, ...controller.addHistory);
  app.get('/history', verifyAuth, ...controller.getUserHistory);
  app.delete('/history/:articleId', verifyAuth, ...controller.deleteHistory);
  app.delete('/history', verifyAuth, ...controller.clearUserHistory);
  app.get('/history/:articleId/check', verifyAuth, ...controller.hasViewed);
}
