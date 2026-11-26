import type { Hono, MiddlewareHandler } from 'hono';
import { CompatibilityRouter } from '../http/compatibility.router.js';
import { createArticleController } from '../controller/article.controller.js';
import type { AppEnv } from '../http/types.js';

const paths = {
  root: '/article',
  recommend: '/article/recommend',
  search: '/article/search',
  randomToc: '/article/random/toc',
  images: '/article/images/:filename',
  video: '/article/video/:filename',
  detail: '/article/:articleId',
  like: '/article/:articleId/like',
  tag: '/article/:articleId/tag',
  view: '/article/:articleId/view',
} as const;

type ArticleRoutes = Parameters<typeof createArticleController>[0] & {
  maintenance: MiddlewareHandler<AppEnv>;
  verifyAuth: MiddlewareHandler<AppEnv>;
  verifyStatus: MiddlewareHandler<AppEnv>;
  verifyPermission: MiddlewareHandler<AppEnv>;
};

export function registerArticleRoutes(
  app: Hono<AppEnv>,
  { maintenance, verifyAuth, verifyStatus, verifyPermission, ...dependencies }: ArticleRoutes,
): void {
  if (app.router instanceof CompatibilityRouter) {
    for (const path of Object.values(paths)) {
      if (path.includes(':')) app.router.preserveLegacyParameterPath(path);
      else app.router.preserveLegacyLiteralPath(path);
    }
  }
  const controller = createArticleController(dependencies);
  app.get(paths.root, ...controller.getList);
  app.get(paths.recommend, ...controller.getRecommendList);
  app.get(paths.search, ...controller.search);
  app.get(paths.randomToc, ...controller.getRandomTocArticle);
  app.get(paths.images, ...controller.getFileInfo);
  app.get(paths.video, ...controller.getVideoInfo);
  app.get(paths.detail, ...controller.getDetail);
  app.get(paths.like, ...controller.getArticleLikedById);
  app.post(paths.root, maintenance, verifyAuth, verifyStatus, ...controller.addArticle);
  app.post(paths.like, verifyAuth, verifyStatus, ...controller.likeArticle);
  app.post(paths.tag, verifyAuth, verifyPermission, ...controller.changeTag);
  app.put(paths.view, ...controller.viewArticle);
  app.put(paths.detail, maintenance, verifyAuth, verifyPermission, ...controller.update);
  app.delete(paths.detail, maintenance, verifyAuth, verifyPermission, ...controller.delete);
}
