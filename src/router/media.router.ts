import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createMediaController } from '../controller/media.controller.js';
import type { AppEnv } from '../http/types.js';

type MediaRoutes = {
  service: Parameters<typeof createMediaController>[0];
  maintenance: MiddlewareHandler<AppEnv>;
  verifyAuth: MiddlewareHandler<AppEnv>;
  uploadImage: MiddlewareHandler<AppEnv>;
};

export function registerMediaRoutes(app: Hono<AppEnv>, { service, maintenance, verifyAuth, uploadImage }: MediaRoutes): void {
  const path = '/media/images';
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath(path);
    app.router.preserveLegacyParameterPath('/media/images/:mediaId');
  }
  const controller = createMediaController(service);
  app.post(path, maintenance, verifyAuth, uploadImage, ...controller.uploadImage);
  app.delete('/media/images/:mediaId', maintenance, verifyAuth, ...controller.deleteImage);
}
