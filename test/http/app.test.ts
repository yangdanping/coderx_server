import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../src/http/app.js';

test('health checks are isolated and bounded', async () => {
  for (const [checkReady, status] of [[async () => true, 200], [async () => false, 503], [async () => { throw Error(); }, 503], [() => new Promise<boolean>(() => {}), 503]] as const) {
    const app = createHttpApp({ buildId: 'test', checkReady, readinessTimeoutMs: 5, registerRoutes() {} });
    assert.deepEqual(await (await app.request('/health/live')).json(), { status: 'ok', buildId: 'test' });
    assert.equal((await app.request('/health/ready')).status, status);
  }
});

test('routing and CORS match legacy behavior', async () => {
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, allowedOrigins: ['https://example.test'], registerRoutes(app) {
    app.post('/tag', c => c.text('post'));
    app.get('/tag', c => c.text('get'));
  }});
  const missing = await app.request('/missing');
  assert.equal(missing.status, 404); assert.equal(await missing.text(), 'Not Found');
  const mismatch = await app.request('/tag/', { method: 'PUT' });
  assert.equal(mismatch.status, 405); assert.equal(mismatch.headers.get('allow'), 'POST, HEAD, GET');
  const head = await app.request('/tag', { method: 'HEAD' });
  assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-type'), 'text/plain; charset=UTF-8');
  const options = await app.request('/tag', { method: 'OPTIONS' });
  assert.equal(options.status, 200); assert.equal(options.headers.get('allow'), 'POST, HEAD, GET');
  const cors = await app.request('/missing', { method: 'OPTIONS', headers: { Origin: 'https://bad.test', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(cors.status, 204); assert.equal(cors.headers.get('access-control-allow-origin'), 'https://example.test');
  assert.equal(cors.headers.get('access-control-allow-methods'), 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
});

test('constrained routes keep strict slash and resource not-found stays 404', async () => {
  const { registerStrictRoute } = await import('../../src/http/registerRoutes.js');
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.get('/flow/draft', c => c.text('draft'));
    registerStrictRoute(app, 'GET', '/flow/:id{[1-9][0-9]*}', c => c.text('numeric'));
    app.get('/resource', c => c.notFound());
  }});
  for (const path of ['/flow/0', '/flow/042', '/flow/42/']) assert.equal((await app.request(path)).status, 404);
  assert.equal(await (await app.request('/flow/42')).text(), 'numeric');
  assert.equal((await app.request('/flow/42/', { method: 'PUT' })).status, 404);
  assert.equal((await app.request('/flow/42', { method: 'PUT' })).status, 405);
  assert.equal(await (await app.request('/flow/draft/')).text(), 'draft');
  assert.equal((await app.request('/resource')).status, 404);
  assert.equal((await app.request('/resource', { method: 'HEAD' })).status, 404);
});

test('route registration order and CORS edge cases', async () => {
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, allowedOrigins: ['https://one.test', 'https://two.test'], registerRoutes(app) {
    app.get('/item/:id', c => c.text('dynamic'));
    app.get('/item/special', c => c.text('static'));
  }});
  assert.equal(await (await app.request('/item/special')).text(), 'dynamic');
  for (const [origin, expected] of [[undefined, 'https://one.test'], ['https://bad.test', 'https://one.test'], ['https://two.test', 'https://two.test']] as const) {
    const r = await app.request('/item/a', { headers: origin ? { Origin: origin } : {} });
    assert.equal(r.headers.get('access-control-allow-origin'), expected);
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    assert.match(r.headers.get('vary') ?? '', /Origin/i);
  }
  const plain = await app.request('/item/a', { method: 'OPTIONS' });
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
  const preflight = await app.request('/unknown', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type,Authorization,Accept');
});

test('liveness does not call readiness', async () => {
  let calls = 0;
  const app = createHttpApp({ buildId: 'test', checkReady: async () => { calls++; return true; }, registerRoutes() {} });
  assert.equal((await app.request('/health/live')).status, 200);
  assert.equal(calls, 0);
  assert.equal((await app.request('/health/ready')).status, 200);
  assert.equal(calls, 1);
});
