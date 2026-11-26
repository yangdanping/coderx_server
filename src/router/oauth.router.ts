import type { Hono } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createOAuthController } from '../controller/oauth.controller.js';
import type { AppEnv } from '../http/types.js';

export function registerOAuthRoutes(app: Hono<AppEnv>, dependencies: Parameters<typeof createOAuthController>[0]): void {
  if (app.router instanceof CompatibilityRouter) {
    for (const path of ['/oauth/status', '/oauth/google', '/oauth/google/callback', '/oauth/google/idtoken', '/oauth/github', '/oauth/github/callback']) {
      app.router.preserveLegacyLiteralPath(path);
    }
  }

  const controller = createOAuthController(dependencies);
  app.get('/oauth/status', ...controller.getStatus);
  app.get('/oauth/google', ...controller.getGoogleAuthUrl);
  app.get('/oauth/google/callback', ...controller.googleCallback);
  app.post('/oauth/google/idtoken', ...controller.googleIdTokenLogin);
  app.get('/oauth/github', ...controller.getGitHubAuthUrl);
  app.get('/oauth/github/callback', ...controller.githubCallback);
}
