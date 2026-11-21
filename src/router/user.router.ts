import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createUserController } from '../controller/user.controller.js';
import type { AppEnv } from '../http/types.js';

const paths = {
  checkAuth: '/user/checkauth',
  register: '/user/register',
  login: '/user/login',
  collect: '/user/:userId/collect',
  comment: '/user/:userId/comment',
  profile: '/user/:userId/profile',
  updateProfile: '/user/profile',
  like: '/user/:userId/like',
  avatar: '/user/:userId/avatar',
  follow: '/user/:userId/follow',
  hot: '/user/hot',
  report: '/user/:userId/report',
} as const;

type UserRouteDependencies = Parameters<typeof createUserController>[0] & { verifyAuth: MiddlewareHandler<AppEnv> };

export function registerUserRoutes(app: Hono<AppEnv>, { verifyAuth, ...dependencies }: UserRouteDependencies): void {
  if (app.router instanceof CompatibilityRouter) {
    for (const path of Object.values(paths)) {
      if (path.includes(':')) app.router.preserveLegacyParameterPath(path);
      else app.router.preserveLegacyLiteralPath(path);
    }
  }
  const controller = createUserController(dependencies);
  app.get(paths.checkAuth, verifyAuth, ...controller.checkAuth);
  app.post(paths.register, ...controller.register);
  app.post(paths.login, ...controller.login);
  app.get(paths.collect, ...controller.getCollect);
  app.get(paths.comment, ...controller.getComment);
  app.get(paths.profile, ...controller.getProfile);
  app.put(paths.updateProfile, verifyAuth, ...controller.updateProfile);
  app.get(paths.like, ...controller.getLiked);
  app.get(paths.avatar, ...controller.getAvatar);
  app.get(paths.follow, ...controller.getFollow);
  app.get(paths.hot, ...controller.getHot);
  app.post(paths.follow, verifyAuth, ...controller.toggleFollow);
  app.post(paths.report, verifyAuth, ...controller.report);
}
