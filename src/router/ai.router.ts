import type { Hono, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../http/types.js';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createAiChatController, createAiController } from '../controller/ai.controller.js';
import { createAiRateLimits } from '../middleware/ai.middleware.js';
export function registerAiChatRoutes(app: Hono<AppEnv>, dependencies: { service: Parameters<typeof createAiChatController>[0]; chatRateLimit?: MiddlewareHandler<AppEnv> }) {
  if (app.router instanceof CompatibilityRouter) app.router.preserveLegacyLiteralPath('/ai/chat');
  app.post('/ai/chat', dependencies.chatRateLimit ?? createAiRateLimits().chat, createAiChatController(dependencies.service));
}

type Dependencies = {
  service: Parameters<typeof createAiController>[0] & Parameters<typeof createAiChatController>[0];
  auth: MiddlewareHandler<AppEnv>;
  clock?: () => number;
};

export function registerAiRoutes(app: Hono<AppEnv>, { service, auth, clock }: Dependencies): void {
  if (app.router instanceof CompatibilityRouter) {
    app.router.preserveLegacyLiteralPath('/ai/health');
    app.router.preserveLegacyLiteralPath('/ai/completion');
  }
  const controller = createAiController(service, clock);
  const limits = createAiRateLimits(clock);
  app.get('/ai/health', ...controller.health);
  registerAiChatRoutes(app, { service, chatRateLimit: limits.chat });
  app.post('/ai/completion', auth, limits.completion, ...controller.completion);
}
