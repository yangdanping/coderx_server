import jsonwebtoken from 'jsonwebtoken';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { createHttpApp } from '../../src/http/app.js';
import { registerOAuthRoutes } from '../../src/router/oauth.router.js';
import { createOAuthService, type OAuthDatabase, type OAuthServiceOptions } from '../../src/service/oauth/oauth.service.js';
import { createSignUserToken } from '../../src/service/user/userToken.service.js';

const { verify, decode } = jsonwebtoken as {
  verify(token: string, key: KeyObject, options: { algorithms: ['RS256'] }): Record<string, unknown>;
  decode(token: string, options: { complete: true }): { header: { alg: string } };
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sevenDays = 7 * 24 * 60 * 60;
const env = {
  GOOGLE_CLIENT_ID: 'fixture-google',
  GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1/oauth/google/callback',
  GITHUB_CLIENT_ID: 'fixture-github',
  GITHUB_CLIENT_SECRET: 'fixture-github-secret',
  GITHUB_REDIRECT_URI: 'http://127.0.0.1/oauth/github/callback',
};

function fixture(database: OAuthDatabase, options: OAuthServiceOptions = { env }, frontendUrl?: string) {
  return createHttpApp({
    buildId: 'oauth-test',
    checkReady: async () => false,
    registerRoutes(app) {
      registerOAuthRoutes(app, {
        service: createOAuthService(database, options),
        signToken: createSignUserToken(keys.privateKey),
        frontendUrl,
        googleClientId: options.env?.GOOGLE_CLIENT_ID,
      });
    },
  });
}

const noDatabase: OAuthDatabase = {
  async execute() { assert.fail('Unexpected database query'); },
  async getConnection() { assert.fail('Unexpected database transaction'); },
};

function assertToken(token: string, user: { id: string | number; name: string }) {
  assert.equal(decode(token, { complete: true }).header.alg, 'RS256');
  const { iat, exp, ...claims } = verify(token, keys.publicKey, { algorithms: ['RS256'] });
  assert.equal(typeof iat, 'number');
  assert.equal(typeof exp, 'number');
  assert.equal(Number(exp) - Number(iat), sevenDays);
  assert.deepEqual(claims, user);
}

function post(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function assertJson(response: Response, expected: unknown) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  assert.deepEqual(await response.json(), expected);
}

test('OAuth status and authorizations preserve config flags, public Client ID, scope and redirect URIs', async () => {
  const app = fixture(noDatabase);
  await assertJson(await app.request('/oAuTh/sTaTuS/'), {
    code: 0, data: { google: true, github: true, googleClientId: env.GOOGLE_CLIENT_ID },
  });
  for (const [path, expected, params] of [
    ['/oauth/google', 'https://accounts.google.com/o/oauth2/v2/auth', {
      access_type: 'offline', scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
      prompt: 'consent', response_type: 'code', client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI,
    }],
    ['/oauth/github', 'https://github.com/login/oauth/authorize', {
      client_id: env.GITHUB_CLIENT_ID, redirect_uri: env.GITHUB_REDIRECT_URI, scope: 'read:user user:email',
    }],
  ] as const) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { authUrl: string }; code: number };
    assert.equal(body.code, 0);
    const url = new URL(body.data.authUrl);
    assert.equal(url.origin + url.pathname, expected);
    assert.deepEqual(Object.fromEntries(url.searchParams), params);
  }
  const head = await app.request('/OAuth/Google/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type') ?? '', /^application\/json\b/);
  const googleBody = await (await app.request('/oauth/google')).text();
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(googleBody)));
  assert.equal(await head.text(), '');
  const options = await app.request('/OAuth/Google/idToken/', { method: 'OPTIONS' });
  assert.equal(options.status, 200);
  assert.equal(options.headers.get('allow'), 'POST');
  const methodMismatch = await app.request('/OAuth/Google/', { method: 'PUT' });
  assert.equal(methodMismatch.status, 405);
  assert.equal(methodMismatch.headers.get('allow'), 'HEAD, GET');
  assert.equal((await app.request('/oauth/%67oogle')).status, 404);
});

test('unconfigured OAuth providers preserve JSON failures and callback error redirects', async () => {
  const app = fixture(noDatabase, { env: { GOOGLE_CLIENT_ID: 'missing-secret' } });
  await assertJson(await app.request('/oauth/status'), { code: 0, data: { google: false, github: false, googleClientId: null } });
  const googleFailure = { code: -1, msg: 'Google OAuth 未配置，请联系管理员' };
  await assertJson(await app.request('/oauth/google'), googleFailure);
  await assertJson(await app.request('/oauth/google/idtoken', post({})), googleFailure);
  await assertJson(await app.request('/oauth/github'), { code: -1, msg: 'GitHub OAuth 未配置，请联系管理员' });
  for (const [provider, name] of [['google', 'Google'], ['github', 'GitHub']]) {
    const response = await app.request('/oauth/' + provider + '/callback?code=fixture', { headers: { accept: 'text/plain' } });
    const location = 'http://localhost:5173/oauth/callback?error=' + encodeURIComponent(name + ' OAuth 未配置');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), location);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), 'Redirecting to ' + location + '.');
  }
});

test('Google callback preserves repeated code, existing account and negotiated redirect with seven-day token', async () => {
  const user = { id: '007', name: '顾客 & friend' };
  const suppliedCodes: unknown[] = [];
  const suppliedTokens: unknown[] = [];
  const credentialsSet: unknown[] = [];
  const database: OAuthDatabase = {
    ...noDatabase,
    async execute(sql, params) {
      assert.match(sql, /google_id = \?/);
      assert.deepEqual(params, ['fixture-google-id']);
      return [[user], []];
    },
  };
  const app = fixture(database, {
    env,
    createGoogleClient(id, secret, redirect) {
      const client = new OAuth2Client(id, secret, redirect);
      return {
        generateAuthUrl: client.generateAuthUrl.bind(client),
        setCredentials(credentials) {
          credentialsSet.push(credentials);
          client.setCredentials(credentials);
        },
        async getToken(code) {
          suppliedCodes.push(code);
          return { tokens: { id_token: 'fixture-id-token' } };
        },
        async verifyIdToken(options) {
          suppliedTokens.push(options);
          return { getPayload: () => ({ sub: 'fixture-google-id' }) };
        },
      };
    },
  }, 'https://frontend.example.test/');
  const missing = await app.request('/oauth/google/callback');
  const missingLocation = 'https://frontend.example.test//oauth/callback?error=missing_code';
  assert.equal(missing.status, 302);
  assert.equal(missing.headers.get('location'), missingLocation);
  assert.equal(missing.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await missing.text(), 'Redirecting to ' + missingLocation + '.');
  const head = await app.request('/oauth/google/callback', { method: 'HEAD' });
  assert.equal(head.status, 302);
  for (const header of ['location', 'content-type']) assert.equal(head.headers.get(header), missing.headers.get(header));
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('Redirecting to ' + missingLocation + '.')));
  assert.equal(await head.text(), '');
  const response = await app.request('/OAUTH/Google/CALLBACK/?code=one+two&code=three%2Bfour');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  const location = response.headers.get('location')!;
  const url = new URL(location);
  assert.equal(url.origin + url.pathname, 'https://frontend.example.test//oauth/callback');
  assert.deepEqual([...url.searchParams.keys()], ['token', 'userId', 'userName']);
  assert.equal(url.searchParams.get('userId'), user.id);
  assert.equal(url.searchParams.get('userName'), user.name);
  assertToken(url.searchParams.get('token')!, user);
  assert.equal(await response.text(), 'Redirecting to ' + location.replaceAll('&', '&amp;') + '.');
  assert.deepEqual(suppliedCodes, [['one two', 'three+four']]);
  assert.deepEqual(credentialsSet, [{ id_token: 'fixture-id-token' }]);
  assert.deepEqual(suppliedTokens, [{ idToken: 'fixture-id-token', audience: env.GOOGLE_CLIENT_ID }]);
});

test('Google ID tokens use credential precedence, normalize aliases and link an existing email account', async () => {
  const user = { id: 9, name: 'saved', password: 'hidden-column' };
  const calls: unknown[][] = [];
  const app = fixture({
    ...noDatabase,
    async execute(sql, params) {
      calls.push(params);
      if (sql.includes('WHERE google_id')) return [[], []];
      if (sql.includes('WHERE p.email')) return [[user], []];
      assert.match(sql, /SET google_id = \?, oauth_provider = \? WHERE id = \?/);
      return [{ affectedRows: 1 }, []];
    },
  }, {
    env,
    createGoogleClient() {
      return {
        generateAuthUrl() { assert.fail('Unexpected Google URL'); },
        setCredentials() { assert.fail('Unexpected Google credentials'); },
        async getToken() { assert.fail('Unexpected Google code exchange'); },
        async verifyIdToken({ idToken }) {
          calls.push(['idToken', idToken]);
          if (idToken === 'invalid') throw new Error('invalid fixture credential');
          return { getPayload: () => ({ sub: 'fixture-link-id', email: 'local@example.test', email_verified: true }) };
        },
      };
    },
  });
  await assertJson(await app.request('/oauth/google/idtoken', post({})), { code: -1, msg: '缺少 Google credential' });
  await assertJson(await app.request('/oauth/google/idtoken', post({ idToken: 'invalid' })), { code: -1, msg: 'invalid fixture credential' });
  for (const body of [{ credential: 'primary', idToken: 'ignored' }, { credential: '', idToken: 'fallback' }]) {
    const response = await app.request('/oauth/google/idtoken', post(body));
    assert.equal(response.status, 200);
    const login = await response.json() as { code: number; data: { token: string; id: number; name: string } };
    assert.deepEqual(login, { code: 0, data: { id: 9, name: 'saved', token: login.data.token } });
    assertToken(login.data.token, { id: 9, name: 'saved' });
  }
  assert.deepEqual(calls, [
    ['idToken', 'invalid'],
    ['idToken', 'primary'], ['fixture-link-id'], ['local@example.test'], ['fixture-link-id', 'google', user.id],
    ['idToken', 'fallback'], ['fixture-link-id'], ['local@example.test'], ['fixture-link-id', 'google', user.id],
  ]);
});

test('GitHub callback requests private emails, creates account in one transaction and encodes provider failures', async () => {
  const calls: unknown[] = [];
  const app = fixture({
    async execute(sql, params) {
      if (sql.includes('WHERE github_id')) assert.deepEqual(params, ['73']);
      else {
        assert.match(sql, /WHERE p.email/);
        assert.deepEqual(params, ['primary@example.test']);
      }
      return [[], []];
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push('begin'); },
        async execute(sql, params) {
          calls.push(params);
          if (sql.includes('RETURNING id')) {
            assert.match(sql, /password, github_id, oauth_provider\)/);
            assert.deepEqual(params.slice(1), ['73', 'github']);
            assert.match(String(params[0]), /^fixture-login_[a-z0-9]+$/);
            return [{ insertId: 27 }, []];
          }
          assert.match(sql, /INSERT INTO profile /);
          assert.deepEqual(params, [27, 'primary@example.test', 'https://images.example.test/avatar']);
          return [{ affectedRows: 1 }, []];
        },
        async commit() { calls.push('commit'); },
        async rollback() { assert.fail('Unexpected transaction rollback'); },
        release() { calls.push('release'); },
      };
    },
  }, {
    env,
    async fetch(input, init) {
      switch (String(input)) {
        case 'https://github.com/login/oauth/access_token': {
          const body = JSON.parse(String(init?.body)) as { code: string };
          assert.deepEqual(body, { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: body.code });
          assert.equal(init?.method, 'POST');
          if (body.code === 'invalid') return Response.json({ error: 'bad_code', error_description: 'denied & rejected' });
          return Response.json({ access_token: 'fixture-access' });
        }
        case 'https://api.github.com/user':
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access');
          return Response.json({ id: 73, login: 'fixture-login', name: null, email: null, avatar_url: 'https://images.example.test/avatar' });
        case 'https://api.github.com/user/emails':
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access');
          return Response.json([
            { email: 'other@example.test', verified: true, primary: false },
            { email: 'primary@example.test', verified: true, primary: true },
          ]);
        default:
          assert.fail('Unexpected provider request');
      }
    },
  });
  const missing = await app.request('/oauth/github/callback?code=');
  assert.equal(missing.headers.get('location'), 'http://localhost:5173/oauth/callback?error=missing_code');
  const denied = await app.request('/oauth/github/callback?code=invalid');
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), 'http://localhost:5173/oauth/callback?error=' + encodeURIComponent('GitHub OAuth 错误: denied & rejected'));
  const response = await app.request('/oauth/github/callback?code=fixture', { headers: { accept: 'text/*;q=1,text/html;q=0' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  const location = response.headers.get('location')!;
  const url = new URL(location);
  const name = url.searchParams.get('userName')!;
  assert.match(name, /^fixture-login_[a-z0-9]+$/);
  assert.equal(url.searchParams.get('userId'), '27');
  assertToken(url.searchParams.get('token')!, { id: 27, name });
  assert.equal(await response.text(), 'Redirecting to ' + location + '.');
  assert.deepEqual(calls, ['begin', [name, '73', 'github'], [27, 'primary@example.test', 'https://images.example.test/avatar'], 'commit', 'release']);
});
