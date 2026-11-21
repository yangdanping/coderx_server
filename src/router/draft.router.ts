import type { Hono, MiddlewareHandler } from 'hono';
import type { DraftService } from '../service/article/article.types.js';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createDraftController } from '../controller/draft.controller.js';
import type { AppEnv } from '../http/types.js';

export function registerDraftRoutes(
  app: Hono<AppEnv>,
  { service, verifyAuth }: { service: DraftService; verifyAuth: MiddlewareHandler<AppEnv> },
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/draft');
    app.router.preserveLegacyParameterPath('/draft/:articleId');
    app.router.preserveLegacyParameterPath('/draft/:draftId');
  }
  const controller = createDraftController(service);
  app.put('/draft', verifyAuth, ...controller.saveDraft);
  app.get('/draft', verifyAuth, ...controller.getDraft);
  app.get('/draft/:articleId', verifyAuth, ...controller.getDraftByArticleId);
  app.delete('/draft/:draftId', verifyAuth, ...controller.deleteDraft);
}
