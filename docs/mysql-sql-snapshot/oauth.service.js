const { OAuth2Client } = require('google-auth-library');
const connection = require('@/app/database');

/**
 * OAuth 2.0 服务
 * 支持 Google 和 GitHub 登录
 *
 * Google OAuth 配置：
 * GOOGLE_CLIENT_ID=你的客户端ID
 * GOOGLE_CLIENT_SECRET=你的客户端密钥
 * GOOGLE_REDIRECT_URI=http://localhost:8000/oauth/google/callback
 *
 * GitHub OAuth 配置：
 * GITHUB_CLIENT_ID=你的客户端ID
 * GITHUB_CLIENT_SECRET=你的客户端密钥
 * GITHUB_REDIRECT_URI=http://localhost:8000/oauth/github/callback
 *
 * GitHub Developer 配置步骤：
 * 1. 访问 https://github.com/settings/developers
 * 2. 点击 "New OAuth App"
 * 3. 填写 Application name、Homepage URL
 * 4. 设置 Authorization callback URL (如上 GITHUB_REDIRECT_URI)
 * 5. 保存后获取 Client ID 和 Client Secret
 */
class OAuthService {
  constructor() {
    this.client = null;
  }

  // 延迟初始化 OAuth2Client（确保环境变量已加载）
  getClient() {
    if (!this.client) {
      const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
      // 调试日志（确认环境变量是否加载）
      console.log('[OAuth] 环境变量检查:', {
        GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID ? `${GOOGLE_CLIENT_ID.substring(0, 20)}...` : '未设置',
        GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET ? '已设置' : '未设置',
      });
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        console.warn('[OAuth] Google OAuth 未配置，请在环境变量中设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET');
        return null;
      }

      this.client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    }
    return this.client;
  }

  /**
   * 生成 Google 授权 URL
   * @returns {string} 授权 URL
   */
  getAuthUrl() {
    const client = this.getClient();
    if (!client) return null;

    return client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/userinfo.email'],
      prompt: 'consent',
    });
  }

  /**
   * 用授权码换取用户信息
   * @param {string} code - Google 返回的授权码
   * @returns {object} Google 用户信息
   */
  async getGoogleUserInfo(code) {
    const client = this.getClient();
    if (!client) throw new Error('Google OAuth 未配置');

    // 用 code 换取 tokens
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // 获取用户信息
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture,
      emailVerified: payload.email_verified,
    };
  }

  /**
   * 通过 Google ID 查找用户
   * @param {string} googleId - Google 用户 ID
   * @returns {object|null} 用户信息
   */
  async findUserByGoogleId(googleId) {
    const statement = 'SELECT * FROM user WHERE google_id = ?;';
    const [result] = await connection.execute(statement, [googleId]);
    return result[0] || null;
  }

  /**
   * 通过邮箱查找用户（用于账号关联）
   * @param {string} email - 邮箱
   * @returns {object|null} 用户信息
   */
  async findUserByEmail(email) {
    const statement = `
      SELECT u.*, p.email as profileEmail
      FROM user u
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE p.email = ?;
    `;
    const [result] = await connection.execute(statement, [email]);
    return result[0] || null;
  }

  /**
   * 创建 OAuth 用户（无密码）
   * @param {object} googleUser - Google 用户信息
   * @returns {object} 新创建的用户
   */
  async createOAuthUser(googleUser) {
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();

      // 生成唯一用户名（使用 Google 名称 + 随机后缀）
      const baseName = googleUser.name || 'User';
      const uniqueName = `${baseName}_${Date.now().toString(36)}`;

      // 插入用户表（密码为 NULL，标记 OAuth 来源）
      const statement1 = 'INSERT INTO user (name, password, google_id, oauth_provider) VALUES (?, NULL, ?, ?);';
      const [result] = await conn.execute(statement1, [uniqueName, googleUser.googleId, 'google']);

      const userId = result.insertId;

      // 插入用户信息表
      const statement2 = 'INSERT INTO profile (user_id, email, avatar_url) VALUES (?, ?, ?);';
      await conn.execute(statement2, [userId, googleUser.email, googleUser.avatarUrl]);

      await conn.commit();

      return {
        id: userId,
        name: uniqueName,
        googleId: googleUser.googleId,
        oauthProvider: 'google',
      };
    } catch (error) {
      await conn.rollback();
      console.error('[OAuth] 创建用户失败:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 关联现有账号与 Google ID
   * @param {number} userId - 用户 ID
   * @param {string} googleId - Google ID
   */
  async linkGoogleAccount(userId, googleId) {
    const statement = 'UPDATE user SET google_id = ?, oauth_provider = ? WHERE id = ?;';
    await connection.execute(statement, [googleId, 'google', userId]);
  }

  /**
   * 检查 Google OAuth 是否已配置
   * @returns {boolean}
   */
  isConfigured() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  }

  // ==================== GitHub OAuth ====================

  /**
   * 检查 GitHub OAuth 是否已配置
   * @returns {boolean}
   */
  isGitHubConfigured() {
    const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = process.env;
    return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
  }

  /**
   * 生成 GitHub 授权 URL
   * @returns {string} 授权 URL
   */
  getGitHubAuthUrl() {
    const { GITHUB_CLIENT_ID, GITHUB_REDIRECT_URI } = process.env;
    if (!GITHUB_CLIENT_ID) return null;

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_REDIRECT_URI,
      scope: 'read:user user:email',
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * 用授权码换取 GitHub 用户信息
   * @param {string} code - GitHub 返回的授权码
   * @returns {object} GitHub 用户信息
   */
  async getGitHubUserInfo(code) {
    const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = process.env;
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      throw new Error('GitHub OAuth 未配置');
    }

    // 1. 用 code 换取 access_token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      throw new Error(`GitHub OAuth 错误: ${tokenData.error_description || tokenData.error}`);
    }

    const accessToken = tokenData.access_token;

    // 2. 用 access_token 获取用户信息
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    const userData = await userResponse.json();
    if (userData.message) {
      throw new Error(`GitHub API 错误: ${userData.message}`);
    }

    // 3. 获取用户邮箱（可能为私有）
    let email = userData.email;
    if (!email) {
      const emailResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      const emails = await emailResponse.json();
      // 优先使用主邮箱，否则使用第一个验证过的邮箱
      const primaryEmail = emails.find((e) => e.primary && e.verified);
      const verifiedEmail = emails.find((e) => e.verified);
      email = primaryEmail?.email || verifiedEmail?.email || null;
    }

    return {
      githubId: String(userData.id), // 转为字符串存储
      email,
      name: userData.name || userData.login,
      avatarUrl: userData.avatar_url,
      login: userData.login, // GitHub 用户名
    };
  }

  /**
   * 通过 GitHub ID 查找用户
   * @param {string} githubId - GitHub 用户 ID
   * @returns {object|null} 用户信息
   */
  async findUserByGitHubId(githubId) {
    const statement = 'SELECT * FROM user WHERE github_id = ?;';
    const [result] = await connection.execute(statement, [githubId]);
    return result[0] || null;
  }

  /**
   * 创建 GitHub OAuth 用户（无密码）
   * @param {object} githubUser - GitHub 用户信息
   * @returns {object} 新创建的用户
   */
  async createGitHubOAuthUser(githubUser) {
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();

      // 生成唯一用户名（使用 GitHub 名称 + 随机后缀）
      const baseName = githubUser.name || githubUser.login || 'User';
      const uniqueName = `${baseName}_${Date.now().toString(36)}`;

      // 插入用户表（密码为 NULL，标记 OAuth 来源）
      const statement1 = 'INSERT INTO user (name, password, github_id, oauth_provider) VALUES (?, NULL, ?, ?);';
      const [result] = await conn.execute(statement1, [uniqueName, githubUser.githubId, 'github']);

      const userId = result.insertId;

      // 插入用户信息表
      const statement2 = 'INSERT INTO profile (user_id, email, avatar_url) VALUES (?, ?, ?);';
      await conn.execute(statement2, [userId, githubUser.email, githubUser.avatarUrl]);

      await conn.commit();

      return {
        id: userId,
        name: uniqueName,
        githubId: githubUser.githubId,
        oauthProvider: 'github',
      };
    } catch (error) {
      await conn.rollback();
      console.error('[OAuth] 创建 GitHub 用户失败:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 关联现有账号与 GitHub ID
   * @param {number} userId - 用户 ID
   * @param {string} githubId - GitHub ID
   */
  async linkGitHubAccount(userId, githubId) {
    const statement = 'UPDATE user SET github_id = ?, oauth_provider = ? WHERE id = ?;';
    await connection.execute(statement, [githubId, 'github', userId]);
  }
}

module.exports = new OAuthService();
