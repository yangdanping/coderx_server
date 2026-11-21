import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createCommentController } from '../controller/comment.controller.js';
import type { AppEnv } from '../http/types.js';

interface CommentRouteDependencies {
  service: Parameters<typeof createCommentController>[0];
  likeService: Parameters<typeof createCommentController>[1];
  verifyAuth: MiddlewareHandler<AppEnv>;
  verifyStatus: MiddlewareHandler<AppEnv>;
  verifyPermission: MiddlewareHandler<AppEnv>;
}

export function registerCommentRoutes(
  app: Hono<AppEnv>,
  { service, likeService, verifyAuth, verifyStatus, verifyPermission }: CommentRouteDependencies,
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/comment');
    for (const path of ['/comment/:commentId', '/comment/:commentId/replies', '/comment/:commentId/reply', '/comment/:commentId/like']) {
      app.router.preserveLegacyParameterPath(path);
    }
    app.router.preserveLegacyLiteralPath('/comment/count');
  }

  const controller = createCommentController(service, likeService);
  app.get('/comment', ...controller.getCommentList);
  app.get('/comment/count', ...controller.getTotalCount);
  app.get('/comment/:commentId/replies', ...controller.getReplies);
  app.get('/comment/:commentId', ...controller.getCommentById);
  app.post('/comment', verifyAuth, verifyStatus, ...controller.addComment);
  app.post('/comment/:commentId/reply', verifyAuth, verifyStatus, ...controller.addReply);
  app.post('/comment/:commentId/like', verifyAuth, ...controller.likeComment);
  app.put('/comment/:commentId', verifyAuth, verifyPermission, ...controller.updateComment);
  app.delete('/comment/:commentId', verifyAuth, verifyPermission, ...controller.deleteComment);
}
