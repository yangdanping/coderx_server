const jwt = require('jsonwebtoken');
const oauthService = require('@/service/oauth.service');
const { PRIVATE_KEY } = require('@/app/config');
const Result = require('@/app/Result');

/**
 * OAuth 控制器
 * 处理 Google OAuth 2.0 登录流程
 */
class OAuthController {
  /**
   * 获取 Google 授权 URL
   * GET /oauth/google
   */
  getGoogleAuthUrl = async (ctx) => {
    if (!oauthService.isConfigured()) {
      ctx.body = Result.fail('Google OAuth 未配置，请联系管理员');
      return;
    }

    const authUrl = oauthService.getAuthUrl();
    ctx.body = Result.success({ authUrl });
  };

  /**
   * Google OAuth 回调处理
   * GET /oauth/google/callback?code=xxx
   *
   * 流程：
   * 1. 用 code 换取 Google 用户信息
   * 2. 检查用户是否已存在（通过 google_id）
   * 3. 不存在则检查邮箱是否已注册（账号关联）
   * 4. 都不存在则创建新用户
   * 5. 颁发 JWT token
   * 6. 重定向到前端并携带 token
   */
  googleCallback = async (ctx) => {
    const { code } = ctx.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (!code) {
      ctx.redirect(`${frontendUrl}/oauth/callback?error=missing_code`);
      return;
    }

    try {
      // 1. 用 code 换取 Google 用户信息
      const googleUser = await oauthService.getGoogleUserInfo(code);
      console.log('[OAuth] Google 用户信息:', googleUser);

      let user = null;

      // 2. 检查是否已通过 Google 登录过
      user = await oauthService.findUserByGoogleId(googleUser.googleId);

      if (!user) {
        // 3. 检查邮箱是否已注册（账号关联场景）
        const existingUser = await oauthService.findUserByEmail(googleUser.email);

        if (existingUser) {
          // 关联现有账号
          await oauthService.linkGoogleAccount(existingUser.id, googleUser.googleId);
          user = { id: existingUser.id, name: existingUser.name };
          console.log('[OAuth] 已关联现有账号:', user.name);
        } else {
          // 4. 创建新用户
          user = await oauthService.createOAuthUser(googleUser);
          console.log('[OAuth] 已创建新用户:', user.name);
        }
      }

      // 5. 颁发 JWT token（复用现有逻辑）
      const token = jwt.sign({ id: user.id, name: user.name }, PRIVATE_KEY, {
        expiresIn: 60 * 60 * 24 * 7, // 7 天
        algorithm: 'RS256',
        allowInsecureKeySizes: true,
      });

      console.log('[OAuth] 登录成功，用户:', user.name);

      // 6. 重定向到前端回调页面，携带 token 和用户信息
      const params = new URLSearchParams({
        token,
        userId: user.id,
        userName: user.name,
      });
      ctx.redirect(`${frontendUrl}/oauth/callback?${params.toString()}`);
    } catch (error) {
      console.error('[OAuth] 登录失败:', error.message);
      ctx.redirect(`${frontendUrl}/oauth/callback?error=${encodeURIComponent(error.message)}`);
    }
  };

  /**
   * 检查 OAuth 配置状态
   * GET /oauth/status
   */
  getStatus = async (ctx) => {
    ctx.body = Result.success({
      google: oauthService.isConfigured(),
    });
  };
}

module.exports = new OAuthController();
