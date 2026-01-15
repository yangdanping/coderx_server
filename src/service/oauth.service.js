const { OAuth2Client } = require('google-auth-library');
const connection = require('@/app/database');

/**
 * Google OAuth 2.0 服务
 *
 * 使用前需要在 .env.development / .env.production 中配置：
 * GOOGLE_CLIENT_ID=你的客户端ID
 * GOOGLE_CLIENT_SECRET=你的客户端密钥
 * GOOGLE_REDIRECT_URI=http://localhost:8000/oauth/google/callback (开发环境)
 *
 * Google Cloud Console 配置步骤：
 * 1. 访问 https://console.cloud.google.com/
 * 2. 创建新项目或选择现有项目
 * 3. 导航到 "APIs & Services" > "Credentials"
 * 4. 点击 "Create Credentials" > "OAuth client ID"
 * 5. 选择 "Web application" 类型
 * 6. 添加授权重定向 URI (如上 GOOGLE_REDIRECT_URI)
 * 7. 保存后获取 Client ID 和 Client Secret
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
   * 检查 OAuth 是否已配置
   * @returns {boolean}
   */
  isConfigured() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  }
}

module.exports = new OAuthService();
