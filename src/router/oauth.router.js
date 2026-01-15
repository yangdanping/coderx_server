const Router = require('koa-router');
const oauthRouter = new Router({ prefix: '/oauth' });
const oauthController = require('@/controller/oauth.controller');

/**
 * OAuth 路由
 *
 * GET /oauth/status          - 检查 OAuth 配置状态
 * GET /oauth/google          - 获取 Google 授权 URL
 * GET /oauth/google/callback - Google OAuth 回调（由 Google 重定向）
 */

// 检查 OAuth 配置状态（前端可用于决定是否显示 Google 登录按钮）
oauthRouter.get('/status', oauthController.getStatus);

// 获取 Google 授权 URL（前端调用后跳转）
oauthRouter.get('/google', oauthController.getGoogleAuthUrl);

// Google OAuth 回调处理
oauthRouter.get('/google/callback', oauthController.googleCallback);

module.exports = oauthRouter;
