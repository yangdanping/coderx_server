import { OAuth2Client, type Credentials, type GenerateAuthUrlOpts, type TokenPayload } from 'google-auth-library';
import {
  buildCreateOAuthUserSql,
  buildFindUserByEmailSql,
  buildFindUserByGitHubIdSql,
  buildFindUserByGoogleIdSql,
  buildLinkOAuthAccountSql,
} from '../sql/oauth.sql.js';

export interface OAuthUser {
  id: number | string;
  name: string;
}

interface OAuthProfile {
  email?: string | null;
  name?: string | null;
  avatarUrl?: string;
}

export interface GoogleProfile extends OAuthProfile {
  googleId: string;
  emailVerified?: boolean;
}

export interface GitHubProfile extends OAuthProfile {
  githubId: string;
  login?: string;
}

type OAuthCode = string | string[];
type OAuthProvider = 'google' | 'github';

interface OAuthQueryExecutor {
  execute(sql: string, params: unknown[]): Promise<readonly [result: unknown, fields: unknown]>;
}

interface OAuthTransaction extends OAuthQueryExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface OAuthDatabase extends OAuthQueryExecutor {
  getConnection(): Promise<OAuthTransaction>;
}

type GooglePayload = Pick<TokenPayload, 'sub' | 'email' | 'name' | 'picture' | 'email_verified'>;

interface GoogleClient {
  generateAuthUrl(options: GenerateAuthUrlOpts): string;
  getToken(code: OAuthCode): Promise<{ tokens: Credentials }>;
  setCredentials(tokens: Credentials): void;
  verifyIdToken(options: { idToken: unknown; audience?: string }): Promise<{ getPayload(): GooglePayload | undefined }>;
}

export interface OAuthServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  createGoogleClient?: (clientId: string, secret: string, redirectUri: string | undefined) => GoogleClient;
}

function createGoogleClient(clientId: string, secret: string, redirectUri: string | undefined): GoogleClient {
  const client = new OAuth2Client(clientId, secret, redirectUri);
  return {
    generateAuthUrl: options => client.generateAuthUrl(options),
    // The legacy provider receives repeated codes and credentials as submitted. Preserve the values at the SDK boundary.
    getToken: code => client.getToken(code as string),
    setCredentials: tokens => client.setCredentials(tokens),
    verifyIdToken: ({ idToken, audience }) => client.verifyIdToken({ idToken: idToken as string, audience }),
  };
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id?: number | string;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  message?: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function createOAuthService(database: OAuthDatabase, options: OAuthServiceOptions = {}) {
  const env = options.env ?? process.env;
  const providerFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const makeGoogleClient = options.createGoogleClient ?? createGoogleClient;
  let googleClient: GoogleClient | undefined;

  function getClient(): GoogleClient | null {
    if (googleClient) return googleClient;
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
    googleClient = makeGoogleClient(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    return googleClient;
  }

  async function getGoogleUserInfoFromIdToken(idToken: unknown): Promise<GoogleProfile> {
    const client = getClient();
    if (!client) throw new Error('Google OAuth 未配置');
    if (!idToken) throw new Error('缺少 Google id_token');
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new Error('无效的 Google token');
    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture,
      emailVerified: payload.email_verified,
    };
  }

  async function findUser(sql: string, value: string | null | undefined): Promise<OAuthUser | null> {
    const [rows] = await database.execute(sql, [value]);
    return (rows as OAuthUser[])[0] || null;
  }

  async function createUser(provider: OAuthProvider, providerId: string, profile: OAuthProfile, baseName: string): Promise<OAuthUser> {
    const transaction = await database.getConnection();
    try {
      await transaction.beginTransaction();
      const name = `${baseName}_${Date.now().toString(36)}`;
      const [result] = await transaction.execute(buildCreateOAuthUserSql(provider), [name, providerId, provider]);
      const { insertId: id } = result as { insertId: OAuthUser['id'] };
      await transaction.execute('INSERT INTO profile (user_id, email, avatar_url) VALUES (?, ?, ?);', [id, profile.email, profile.avatarUrl]);
      await transaction.commit();
      return { id, name };
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.release();
    }
  }

  async function linkAccount(provider: OAuthProvider, userId: OAuthUser['id'], providerId: string) {
    await database.execute(buildLinkOAuthAccountSql(provider), [providerId, provider, userId]);
  }

  return {
    getClient,

    isConfigured: () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),

    getAuthUrl() {
      const client = getClient();
      return client?.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/userinfo.email'],
        prompt: 'consent',
      }) ?? null;
    },

    getGoogleUserInfoFromIdToken,

    async getGoogleUserInfo(code: OAuthCode): Promise<GoogleProfile> {
      const client = getClient();
      if (!client) throw new Error('Google OAuth 未配置');
      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);
      return getGoogleUserInfoFromIdToken(tokens.id_token);
    },

    findUserByGoogleId: (googleId: string) => findUser(buildFindUserByGoogleIdSql(), googleId),

    findUserByEmail: (email: OAuthProfile['email']) => findUser(buildFindUserByEmailSql(), email),

    async createOAuthUser(profile: GoogleProfile) {
      const user = await createUser('google', profile.googleId, profile, profile.name || 'User');
      return { ...user, googleId: profile.googleId, oauthProvider: 'google' };
    },

    linkGoogleAccount: (userId: OAuthUser['id'], googleId: string) => linkAccount('google', userId, googleId),

    isGitHubConfigured: () => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),

    getGitHubAuthUrl() {
      const { GITHUB_CLIENT_ID, GITHUB_REDIRECT_URI } = env;
      if (!GITHUB_CLIENT_ID) return null;
      const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: String(GITHUB_REDIRECT_URI),
        scope: 'read:user user:email',
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },

    async getGitHubUserInfo(code: OAuthCode): Promise<GitHubProfile> {
      const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = env;
      if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) throw new Error('GitHub OAuth 未配置');

      const tokenResponse = await providerFetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }),
      });
      const token = await tokenResponse.json() as GitHubTokenResponse;
      if (token.error) throw new Error(`GitHub OAuth 错误: ${token.error_description || token.error}`);

      const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github.v3+json' };
      const userResponse = await providerFetch('https://api.github.com/user', { headers });
      const user = await userResponse.json() as GitHubUserResponse;
      if (user.message) throw new Error(`GitHub API 错误: ${user.message}`);

      let email = user.email;
      if (!email) {
        const emailResponse = await providerFetch('https://api.github.com/user/emails', { headers });
        const emails = await emailResponse.json() as GitHubEmail[];
        const primary = emails.find(entry => entry.primary && entry.verified);
        const verified = emails.find(entry => entry.verified);
        email = primary?.email || verified?.email || null;
      }

      return { githubId: String(user.id), email, name: user.name || user.login, avatarUrl: user.avatar_url, login: user.login };
    },

    findUserByGitHubId: (githubId: string) => findUser(buildFindUserByGitHubIdSql(), githubId),

    async createGitHubOAuthUser(profile: GitHubProfile) {
      const user = await createUser('github', profile.githubId, profile, profile.name || profile.login || 'User');
      return { ...user, githubId: profile.githubId, oauthProvider: 'github' };
    },

    linkGitHubAccount: (userId: OAuthUser['id'], githubId: string) => linkAccount('github', userId, githubId),
  };
}

export type OAuthService = ReturnType<typeof createOAuthService>;

type GoogleAccounts = Pick<OAuthService, 'findUserByGoogleId' | 'findUserByEmail' | 'linkGoogleAccount' | 'createOAuthUser'>;
type GitHubAccounts = Pick<OAuthService, 'findUserByGitHubId' | 'findUserByEmail' | 'linkGitHubAccount' | 'createGitHubOAuthUser'>;

export async function resolveGoogleUser(service: GoogleAccounts, profile: GoogleProfile): Promise<OAuthUser> {
  const providerUser = await service.findUserByGoogleId(profile.googleId);
  if (providerUser) return providerUser;
  const existingUser = await service.findUserByEmail(profile.email);
  if (!existingUser) return service.createOAuthUser(profile);

  await service.linkGoogleAccount(existingUser.id, profile.googleId);
  return { id: existingUser.id, name: existingUser.name };
}

export async function resolveGitHubUser(service: GitHubAccounts, profile: GitHubProfile): Promise<OAuthUser> {
  const providerUser = await service.findUserByGitHubId(profile.githubId);
  if (providerUser) return providerUser;
  const existingUser = profile.email ? await service.findUserByEmail(profile.email) : null;
  if (!existingUser) return service.createGitHubOAuthUser(profile);

  await service.linkGitHubAccount(existingUser.id, profile.githubId);
  return { id: existingUser.id, name: existingUser.name };
}
