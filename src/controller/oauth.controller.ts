import type { IncomingMessage } from 'node:http';
import accepts from 'accepts';
import encodeUrl from 'encodeurl';
import escapeHtml from 'escape-html';
import type { Context } from 'hono';
import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import { resolveGitHubUser, resolveGoogleUser, type OAuthService, type OAuthUser } from '../service/oauth/oauth.service.js';
import { legacyJson } from '../http/legacyResponse.js';
import type { AppEnv } from '../http/types.js';

interface OAuthDependencies {
  service: Omit<OAuthService, 'getClient'>;
  signToken: (user: OAuthUser) => string;
  frontendUrl: string | undefined;
  googleClientId: string | undefined;
}

const { createHandlers } = createFactory<AppEnv>();
const acceptsHeaders = accepts as (request: Pick<IncomingMessage, 'headers'>) => accepts.Accepts;

function redirect(c: Context<AppEnv>, target: string) {
  const url = /^https?:\/\//i.test(target) ? new URL(target).toString() : target;
  c.header('Location', encodeUrl(url));
  const html = Boolean(acceptsHeaders({ headers: { accept: c.req.header('accept') } }).types('html'));
  const body = `Redirecting to ${html ? escapeHtml(url) : url}.`;
  c.header('Content-Type', html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
  c.header('Content-Length', String(Buffer.byteLength(body)));
  return c.body(body, 302);
}

export function createOAuthController({ service, signToken, frontendUrl, googleClientId }: OAuthDependencies) {
  const callbackUrl = `${frontendUrl || 'http://localhost:5173'}/oauth/callback`;

  function callback(resolveUser: (code: string | string[]) => Promise<OAuthUser>) {
    return createHandlers(async c => {
      const codes = new URL(c.req.url).searchParams.getAll('code');
      const code = codes.length > 1 ? codes : codes[0];
      if (!code) return redirect(c, `${callbackUrl}?error=missing_code`);

      try {
        const user = await resolveUser(code);
        const params = new URLSearchParams({ token: signToken(user), userId: String(user.id), userName: user.name });
        return redirect(c, `${callbackUrl}?${params.toString()}`);
      } catch (error) {
        const { message } = error as { message?: unknown };
        return redirect(c, `${callbackUrl}?error=${encodeURIComponent(String(message))}`);
      }
    });
  }

  return {
    googleCallback: callback(async code => resolveGoogleUser(service, await service.getGoogleUserInfo(code))),

    githubCallback: callback(async code => resolveGitHubUser(service, await service.getGitHubUserInfo(code))),

    googleIdTokenLogin: createHandlers(async c => {
      if (!service.isConfigured()) return legacyJson(c, Result.fail('Google OAuth 未配置，请联系管理员'));
      const body = c.get('parsedBody') as { credential?: unknown; idToken?: unknown } | null | undefined;
      const idToken = body?.credential || body?.idToken;
      if (!idToken) return legacyJson(c, Result.fail('缺少 Google credential'));
      try {
        const user = await resolveGoogleUser(service, await service.getGoogleUserInfoFromIdToken(idToken));
        return legacyJson(c, Result.success({ id: user.id, name: user.name, token: signToken(user) }));
      } catch (error) {
        const { message } = error as { message?: unknown };
        return legacyJson(c, Result.fail(message || 'Google 登录失败'));
      }
    }),

    getStatus: createHandlers(c => {
      const google = service.isConfigured();
      return legacyJson(c, Result.success({
        google,
        github: service.isGitHubConfigured(),
        googleClientId: google ? googleClientId || null : null,
      }));
    }),

    getGoogleAuthUrl: createHandlers(c => legacyJson(c, service.isConfigured()
      ? Result.success({ authUrl: service.getAuthUrl() })
      : Result.fail('Google OAuth 未配置，请联系管理员'))),

    getGitHubAuthUrl: createHandlers(c => legacyJson(c, service.isGitHubConfigured()
      ? Result.success({ authUrl: service.getGitHubAuthUrl() })
      : Result.fail('GitHub OAuth 未配置，请联系管理员'))),
  };
}
