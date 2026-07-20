const jwt = require('jsonwebtoken');
const oauthService = require('@/service/oauth.service');
const { PRIVATE_KEY } = require('@/app/config');
const Result = require('@/app/Result');

/**
 * OAuth 控制器
 * 处理 Google 和 GitHub OAuth 2.0 登录流程
 */
class OAuthController {
  signToken(user) {
    return jwt.sign({ id: user.id, name: user.name }, PRIVATE_KEY, {
      expiresIn: 60 * 60 * 24 * 7, // 7 天
      algorithm: 'RS256',
      allowInsecureKeySizes: true,
    });
  }

  /**
   * 按 Google 身份查找 / 关联 / 创建用户
   * @param {object} googleUser
   * @returns {Promise<{ id: number, name: string }>}
   */
  async resolveGoogleUser(googleUser) {
    let user = await oauthService.findUserByGoogleId(googleUser.googleId);

    if (!user) {
      const existingUser = await oauthService.findUserByEmail(googleUser.email);

      if (existingUser) {
        await oauthService.linkGoogleAccount(existingUser.id, googleUser.googleId);
        user = { id: existingUser.id, name: existingUser.name };
        console.log('[OAuth] 已关联现有账号:', user.name);
      } else {
        user = await oauthService.createOAuthUser(googleUser);
        console.log('[OAuth] 已创建新用户:', user.name);
      }
    }

    return user;
  }

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
      const googleUser = await oauthService.getGoogleUserInfo(code);
      console.log('[OAuth] Google 用户信息:', googleUser);

      const user = await this.resolveGoogleUser(googleUser);
      const token = this.signToken(user);

      console.log('[OAuth] 登录成功，用户:', user.name);

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
   * Google One Tap / GIS id_token 登录
   * POST /oauth/google/idtoken
   * body: { credential: string } 或 { idToken: string }
   */
  googleIdTokenLogin = async (ctx) => {
    if (!oauthService.isConfigured()) {
      ctx.body = Result.fail('Google OAuth 未配置，请联系管理员');
      return;
    }

    const idToken = ctx.request.body?.credential || ctx.request.body?.idToken;
    if (!idToken) {
      ctx.body = Result.fail('缺少 Google credential');
      return;
    }

    try {
      const googleUser = await oauthService.getGoogleUserInfoFromIdToken(idToken);
      console.log('[OAuth] Google One Tap 用户信息:', googleUser);

      const user = await this.resolveGoogleUser(googleUser);
      const token = this.signToken(user);

      console.log('[OAuth] One Tap 登录成功，用户:', user.name);
      ctx.body = Result.success({ id: user.id, name: user.name, token });
    } catch (error) {
      console.error('[OAuth] One Tap 登录失败:', error.message);
      ctx.body = Result.fail(error.message || 'Google 登录失败');
    }
  };

  /**
   * 检查 OAuth 配置状态
   * GET /oauth/status
   */
  getStatus = async (ctx) => {
    const googleConfigured = oauthService.isConfigured();
    ctx.body = Result.success({
      google: googleConfigured,
      github: oauthService.isGitHubConfigured(),
      // Client ID 本身可公开；前端 GIS One Tap 需要用它初始化
      googleClientId: googleConfigured ? process.env.GOOGLE_CLIENT_ID || null : null,
    });
  };

  // ==================== GitHub OAuth ====================

  /**
   * 获取 GitHub 授权 URL
   * GET /oauth/github
   */
  getGitHubAuthUrl = async (ctx) => {
    if (!oauthService.isGitHubConfigured()) {
      ctx.body = Result.fail('GitHub OAuth 未配置，请联系管理员');
      return;
    }

    const authUrl = oauthService.getGitHubAuthUrl();
    ctx.body = Result.success({ authUrl });
  };

  /**
   * GitHub OAuth 回调处理
   * GET /oauth/github/callback?code=xxx
   *
   * 流程：
   * 1. 用 code 换取 GitHub 用户信息
   * 2. 检查用户是否已存在（通过 github_id）
   * 3. 不存在则检查邮箱是否已注册（账号关联）
   * 4. 都不存在则创建新用户
   * 5. 颁发 JWT token
   * 6. 重定向到前端并携带 token
   */
  githubCallback = async (ctx) => {
    const { code } = ctx.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (!code) {
      ctx.redirect(`${frontendUrl}/oauth/callback?error=missing_code`);
      return;
    }

    try {
      // 1. 用 code 换取 GitHub 用户信息
      const githubUser = await oauthService.getGitHubUserInfo(code);
      console.log('[OAuth] GitHub 用户信息:', githubUser);

      let user = null;

      // 2. 检查是否已通过 GitHub 登录过
      user = await oauthService.findUserByGitHubId(githubUser.githubId);

      if (!user) {
        // 3. 检查邮箱是否已注册（账号关联场景）
        if (githubUser.email) {
          const existingUser = await oauthService.findUserByEmail(githubUser.email);

          if (existingUser) {
            // 关联现有账号
            await oauthService.linkGitHubAccount(existingUser.id, githubUser.githubId);
            user = { id: existingUser.id, name: existingUser.name };
            console.log('[OAuth] 已关联现有账号:', user.name);
          }
        }

        if (!user) {
          // 4. 创建新用户
          user = await oauthService.createGitHubOAuthUser(githubUser);
          console.log('[OAuth] 已创建新 GitHub 用户:', user.name);
        }
      }

      // 5. 颁发 JWT token（复用现有逻辑）
      const token = this.signToken(user);

      console.log('[OAuth] GitHub 登录成功，用户:', user.name);

      // 6. 重定向到前端回调页面，携带 token 和用户信息
      const params = new URLSearchParams({
        token,
        userId: user.id,
        userName: user.name,
      });
      ctx.redirect(`${frontendUrl}/oauth/callback?${params.toString()}`);
    } catch (error) {
      console.error('[OAuth] GitHub 登录失败:', error.message);
      ctx.redirect(`${frontendUrl}/oauth/callback?error=${encodeURIComponent(error.message)}`);
    }
  };
}

module.exports = new OAuthController();
