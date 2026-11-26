import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createNotificationController } from '../controller/notification.controller.js';
import type { AppEnv } from '../http/types.js';

export function registerNotificationRoutes(
  app: Hono<AppEnv>,
  { service, verifyAuth }: { service: Parameters<typeof createNotificationController>[0]; verifyAuth: MiddlewareHandler<AppEnv> },
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/notification');
    app.router.preserveLegacyLiteralPath('/notification/unread-count');
    app.router.preserveLegacyLiteralPath('/notification/read-all');
    app.router.preserveLegacyParameterPath('/notification/:notificationId/read');
  }
  const controller = createNotificationController(service);
  app.get('/notification', verifyAuth, ...controller.list);
  app.get('/notification/unread-count', verifyAuth, ...controller.unreadCount);
  app.patch('/notification/read-all', verifyAuth, ...controller.markAllRead);
  app.patch('/notification/:notificationId/read', verifyAuth, ...controller.markRead);
}
