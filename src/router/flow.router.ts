import type { Hono, MiddlewareHandler } from 'hono';
import type { FlowService } from '../service/flow.types.js';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createFlowController } from '../controller/flow.controller.js';
import { registerStrictRoute } from '../http/registerRoutes.js';
import type { AppEnv } from '../http/types.js';

const root = '/flow';
const detail = '/flow/:flowId{[1-9][0-9]*}';

export function registerFlowRoutes(
  app: Hono<AppEnv>,
  { service, maintenance, verifyAuth, verifyStatus }: {
    service: FlowService;
    maintenance: MiddlewareHandler<AppEnv>;
    verifyAuth: MiddlewareHandler<AppEnv>;
    verifyStatus: MiddlewareHandler<AppEnv>;
  },
): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath(root);
    app.router.preserveLegacyRegexPath(detail, /^\/flow\/([1-9]\d*)$/);
  }
  const controller = createFlowController(service);
  app.post(root, maintenance, verifyAuth, verifyStatus, ...controller.createFlow);
  app.get(root, ...controller.getFlowFeed);
  registerStrictRoute(app, 'GET', detail, ...controller.getFlowDetail);
}
