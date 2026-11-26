import { frozenHttpContract } from '../support/frozen-http-contract.js';
import '../support/runtime-guard.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Handler } from 'hono';
import { createHttpApp, type AppEnv } from '../../src/http/app.js';
import { CompatibilityRouter } from '../../src/http/compatibility.router.js';
import { registerStrictRoute } from '../../src/http/registerRoutes.js';

for (const strictFirst of [true, false]) {
  for (const looseMethod of ['get', 'post'] as const) {
    test(`strict/loose overlap preserves legacy responses: strictFirst=${strictFirst}, loose=${looseMethod}`, async () => {
      const candidate = createHttpApp({
        buildId: 'test', checkReady: async () => false,
        registerRoutes(app) {
          const strict = () => {
            registerStrictRoute(app, 'GET', '/overlap/:id{[1-9][0-9]*}', c => c.text('strict'));
          };
          const loose = () => {
            app[looseMethod]('/overlap/:id', c => c.text(`loose:${c.req.param('id')}`));
          };
          for (const register of strictFirst ? [strict, loose] : [loose, strict]) register();
        },
      });
      const contract = frozenHttpContract(`overlap:${strictFirst ? 'strict' : 'loose'}:${looseMethod}`);
      for (const path of ['/overlap/42', '/overlap/42/', '/overlap/0', '/overlap/abc/']) {
        for (const method of ['GET', 'POST', 'PUT', 'OPTIONS', 'HEAD']) {
          const actual = await candidate.request(path, { method });
          contract.assert(method, path, { status: actual.status, allow: actual.headers.get('allow'), body: await actual.text() });
        }
      }
      contract.assertComplete();
    });
  }
}

test('strictness belongs to a registration, including reused handlers and identical patterns', async () => {
  const shared: Handler<AppEnv> = c => c.text(c.req.method);
  const app = createHttpApp({ buildId: 'test', checkReady: async () => false, registerRoutes(app) {
    registerStrictRoute(app, 'GET', '/same/:id{[1-9][0-9]*}', shared);
    app.post('/same/:id{[1-9][0-9]*}', shared);
    registerStrictRoute(app, 'GET', '/fallback/:id{[1-9][0-9]*}', c => c.text('strict'));
    app.get('/fallback/:id{[1-9][0-9]*}', c => c.text('loose'));
  } });
  assert.equal(await (await app.request('/same/42/', { method: 'POST' })).text(), 'POST');
  const mismatch = await app.request('/same/42/');
  assert.equal(mismatch.status, 405);
  assert.equal(mismatch.headers.get('allow'), 'POST');
  assert.equal(await (await app.request('/fallback/42/')).text(), 'loose');
  assert.equal(await (await app.request('/fallback/42')).text(), 'strict');
});

test('a loose handler calling next cannot make a strict route accept a trailing slash', async () => {
  const app = createHttpApp({ buildId: 'test', checkReady: async () => false, registerRoutes(app) {
    app.get('/chain/:id', async (_c, next) => { await next(); });
    registerStrictRoute(app, 'GET', '/chain/:id{[1-9][0-9]*}', c => c.text('strict'));
  } });
  assert.equal((await app.request('/chain/42/')).status, 404);
  assert.equal(await (await app.request('/chain/42')).text(), 'strict');
});

test('Legacy canonicalization selects the registered method template and negotiates all raw-path matches', async () => {
  const candidate = createHttpApp({
    buildId: 'method-template-test', checkReady: async () => false,
    registerRoutes(app) {
      const registrations = [
        ['GET', '/article/recommend', 'recommend'],
        ['GET', '/article/images/:filename', 'image'],
        ['GET', '/article/video/:filename', 'video'],
        ['GET', '/article/:articleId', 'detail'],
        ['GET', '/article/:articleId/like', 'likeCount'],
        ['POST', '/article/:articleId/like', 'toggleLike'],
        ['PUT', '/article/:articleId', 'update'],
        ['DELETE', '/article/:articleId', 'delete'],
      ] as const;
      for (const [method, path, name] of registrations) {
        if (app.router instanceof CompatibilityRouter) {
          if (path.includes(':')) app.router.preserveLegacyParameterPath(path);
          else app.router.preserveLegacyLiteralPath(path);
        }
        app.on(method, path, c => c.json({ name, params: c.req.param() }));
      }
    },
  });
  const contract = frozenHttpContract('canonical');
  for (const path of [
    '/article/VIDEO/LIKE', '/article/VIDEO/like', '/article/video/LIKE',
    '/article/IMAGES/like/', '/article/RECOMMEND', '/ARTICLE/ReCoMmEnD/',
    '/article/%72ecommend', '/article/VIDEO/other', '/article/Video/a%252Fb',
  ]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'SEARCH']) {
      const actual = await candidate.request(path, { method });
      contract.assert(method, path, { status: actual.status, allow: actual.headers.get('allow'), body: await actual.text() });
    }
  }
  contract.assertComplete();
});
