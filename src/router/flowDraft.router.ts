import type { Hono, MiddlewareHandler } from 'hono';
import type { FlowDraftService } from '../service/flow.types.js';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createFlowDraftController } from '../controller/flowDraft.controller.js';
import type { AppEnv } from '../http/types.js';

const root = '/flow/draft';
const item = '/flow/draft/:draftId';

export function registerFlowDraftRoutes(
  app: Hono<AppEnv>,
  { service, verifyAuth }: { service: FlowDraftService; verifyAuth: MiddlewareHandler<AppEnv> },
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath(root);
    app.router.preserveLegacyParameterPath(item);
  }
  const controller = createFlowDraftController(service);
  app.put(root, verifyAuth, ...controller.saveFlowDraft);
  app.get(root, verifyAuth, ...controller.getFlowDraft);
  app.delete(item, verifyAuth, ...controller.deleteFlowDraft);
}
