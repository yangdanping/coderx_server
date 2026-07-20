const Router = require('@koa/router');
const oauthRouter = new Router({ prefix: '/oauth' });
const oauthController = require('@/controller/oauth.controller');

/**
 * OAuth 路由
 *
 * GET  /oauth/status              - 检查 OAuth 配置状态（返回 google/github 是否可用）
 * GET  /oauth/google              - 获取 Google 授权 URL
 * GET  /oauth/google/callback     - Google OAuth 回调（由 Google 重定向）
 * POST /oauth/google/idtoken      - Google One Tap / GIS id_token 登录
 * GET  /oauth/github              - 获取 GitHub 授权 URL
 * GET  /oauth/github/callback     - GitHub OAuth 回调（由 GitHub 重定向）
 */

// 检查 OAuth 配置状态（前端可用于决定是否显示 OAuth 登录按钮）
oauthRouter.get('/status', oauthController.getStatus);

// ==================== Google OAuth ====================
// 获取 Google 授权 URL（前端调用后跳转）
oauthRouter.get('/google', oauthController.getGoogleAuthUrl);

// Google OAuth 回调处理
oauthRouter.get('/google/callback', oauthController.googleCallback);

// Google One Tap / GIS：前端提交 credential (id_token)
oauthRouter.post('/google/idtoken', oauthController.googleIdTokenLogin);

// ==================== GitHub OAuth ====================
// 获取 GitHub 授权 URL（前端调用后跳转）
oauthRouter.get('/github', oauthController.getGitHubAuthUrl);

// GitHub OAuth 回调处理
oauthRouter.get('/github/callback', oauthController.githubCallback);

module.exports = oauthRouter;
