import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createVideoController } from '../controller/video.controller.js';
import type { AppEnv } from '../http/types.js';

const paths = { root: '/video', association: '/video/:articleId', detail: '/video/:videoId' } as const;

type VideoRoutes = {
  operations: Parameters<typeof createVideoController>[0];
  maintenance: MiddlewareHandler<AppEnv>;
  verifyAuth: MiddlewareHandler<AppEnv>;
  uploadVideo: MiddlewareHandler<AppEnv>;
};

export function registerVideoRoutes(app: Hono<AppEnv>, { operations, maintenance, verifyAuth, uploadVideo }: VideoRoutes): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath(paths.root);
    app.router.preserveLegacyParameterPath(paths.association);
    app.router.preserveLegacyParameterPath(paths.detail);
  }
  const controller = createVideoController(operations);
  app.post(paths.root, maintenance, verifyAuth, uploadVideo, ...controller.saveVideoInfo);
  app.post(paths.association, maintenance, verifyAuth, ...controller.updateVideoArticle);
  app.delete(paths.root, maintenance, verifyAuth, ...controller.deleteVideo);
  app.get(paths.detail, ...controller.getVideoInfo);
}
