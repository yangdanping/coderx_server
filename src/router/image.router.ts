import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createImageController } from '../controller/image.controller.js';
import type { AppEnv } from '../http/types.js';

type ImageRoutes = {
  service: Parameters<typeof createImageController>[0];
  publicApiOrigin: string;
  maintenance: MiddlewareHandler<AppEnv>;
  verifyAuth: MiddlewareHandler<AppEnv>;
  uploadImage: MiddlewareHandler<AppEnv>;
};

export function registerImageRoutes(
  app: Hono<AppEnv>, { service, publicApiOrigin, maintenance, verifyAuth, uploadImage }: ImageRoutes,
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/img');
    app.router.preserveLegacyParameterPath('/img/:articleId');
  }
  const controller = createImageController(service, publicApiOrigin);
  app.post('/img', maintenance, verifyAuth, uploadImage, ...controller.saveImages);
  app.post('/img/:articleId', maintenance, verifyAuth, ...controller.associateImages);
  app.delete('/img', maintenance, verifyAuth, ...controller.deleteImages);
}
