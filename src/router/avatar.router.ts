import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createAvatarController } from '../controller/avatar.controller.js';
import type { AppEnv } from '../http/types.js';

type AvatarRoutes = {
  service: Parameters<typeof createAvatarController>[0];
  verifyAuth: MiddlewareHandler<AppEnv>;
  uploadAvatar: MiddlewareHandler<AppEnv>;
};

export function registerAvatarRoutes(app: Hono<AppEnv>, { service, verifyAuth, uploadAvatar }: AvatarRoutes): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/avatar');
    app.router.preserveLegacyParameterPath('/avatar/:userId');
  }
  const controller = createAvatarController(service);
  app.post('/avatar', verifyAuth, uploadAvatar, ...controller.saveAvatar);
  app.delete('/avatar/:userId', verifyAuth, ...controller.deleteAvatar);
}
