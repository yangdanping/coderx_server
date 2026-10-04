const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const jwt = require('jsonwebtoken');

require('module-alias/register');

const Result = require('@/app/Result');
const errorTypes = require('@/constants/errorTypes');
const modulePaths = Object.fromEntries(
  [
    ['router', 'router/flow.router.js'],
    ['controller', 'controller/flow.controller.js'],
    ['auth', 'middleware/auth.middleware.js'],
    ['authService', 'service/auth.service.js'],
    ['maintenance', 'middleware/mediaMaintenance.middleware.js'],
    ['config', 'app/config.js'],
    ['errorHandler', 'app/errorHandler.js'],
    ['logger', 'app/logger.js'],
  ].map(([name, file]) => [name, path.resolve(__dirname, '../../src', file)]),
);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function injectCache(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

async function createFixture(t, { status = 0, paused = false } = {}) {
  const originalModules = new Map(Object.values(modulePaths).map((modulePath) => [modulePath, require.cache[modulePath]]));
  for (const modulePath of originalModules.keys()) delete require.cache[modulePath];
  t.after(() => {
    for (const [modulePath, original] of originalModules) {
      if (original) require.cache[modulePath] = original;
      else delete require.cache[modulePath];
    }
  });

  const statusCalls = [];
  const createCalls = [];
  const readCalls = [];
  let currentStatus = status;
  injectCache(modulePaths.config, { PUBLIC_KEY: publicKey, MEDIA_MUTATIONS_PAUSED: String(paused) });
  injectCache(modulePaths.logger, { errorLogger: { error() {} } });
  injectCache(modulePaths.authService, {
    async checkStatus(userId) {
      statusCalls.push(userId);
      return currentStatus;
    },
  });
  injectCache(modulePaths.controller, {
    async createFlow(ctx) {
      createCalls.push({ userId: ctx.user.id, body: ctx.request.body });
      ctx.body = Result.success({ id: 90 });
    },
    async getFlowFeed(ctx) {
      readCalls.push('feed');
      ctx.body = Result.success({ items: [] });
    },
    async getFlowDetail(ctx) {
      readCalls.push(ctx.params.flowId);
      ctx.body = Result.success({ id: Number(ctx.params.flowId) });
    },
  });

  const app = new Koa();
  app.on('error', require(modulePaths.errorHandler));
  app.use(bodyParser()).use(require(modulePaths.router).routes());
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  return {
    statusCalls,
    createCalls,
    readCalls,
    setStatus(value) {
      currentStatus = value;
    },
    token(expiresIn = '5m') {
      return jwt.sign({ id: 7, name: 'flow-router-test', status: 0 }, privateKey, { algorithm: 'RS256', expiresIn });
    },
    async request(method, route = '/flow', { token, body } = {}) {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body) headers['content-type'] = 'application/json';
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

const publication = {
  clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf',
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Flow router authorization test' }] }] },
  mediaIds: [],
  draft: null,
};

test('POST /flow blocks an already issued valid JWT after the account is banned', async (t) => {
  const fixture = await createFixture(t);
  const token = fixture.token();

  const beforeBan = await fixture.request('POST', '/flow', { token, body: publication });
  assert.deepEqual(beforeBan, { status: 200, body: Result.success({ id: 90 }) });
  assert.equal(fixture.createCalls.length, 1);

  fixture.setStatus(1);
  const afterBan = await fixture.request('POST', '/flow', { token, body: publication });

  assert.equal(fixture.createCalls.length, 1, 'the banned request must not reach createFlow or perform a mutation');
  assert.deepEqual(afterBan, { status: 200, body: Result.fail('您已被封禁') });
  assert.deepEqual(fixture.statusCalls, [7, 7]);
});

test('POST /flow allows an authenticated account with a normal current status', async (t) => {
  const fixture = await createFixture(t);
  const response = await fixture.request('POST', '/flow', { token: fixture.token(), body: publication });

  assert.deepEqual(response, { status: 200, body: Result.success({ id: 90 }) });
  assert.deepEqual(fixture.statusCalls, [7]);
  assert.deepEqual(fixture.createCalls, [{ userId: 7, body: publication }]);
});

test('POST /flow rejects missing, invalid, and expired authorization before status queries or mutations', async (t) => {
  for (const kind of ['missing', 'invalid', 'expired']) {
    await t.test(kind, async (t) => {
      const fixture = await createFixture(t);
      const token = kind === 'invalid' ? 'not-a-jwt' : kind === 'expired' ? fixture.token(-1) : undefined;
      const response = await fixture.request('POST', '/flow', { token, body: publication });

      assert.deepEqual(response, { status: 401, body: Result.fail(errorTypes.UNAUTH, 401) });
      assert.deepEqual(fixture.statusCalls, []);
      assert.deepEqual(fixture.createCalls, []);
    });
  }
});

test('GET /flow and GET /flow/:id remain public without querying account status', async (t) => {
  const fixture = await createFixture(t, { status: 1 });
  for (const token of [undefined, fixture.token()]) {
    const feed = await fixture.request('GET', '/flow', { token });
    const detail = await fixture.request('GET', '/flow/42', { token });

    assert.deepEqual(feed, { status: 200, body: Result.success({ items: [] }) });
    assert.deepEqual(detail, { status: 200, body: Result.success({ id: 42 }) });
  }
  assert.deepEqual(fixture.readCalls, ['feed', '42', 'feed', '42']);
  assert.deepEqual(fixture.statusCalls, []);
  assert.deepEqual(fixture.createCalls, []);
});

test('POST /flow returns media maintenance before authorization or account status checks', async (t) => {
  const fixture = await createFixture(t, { paused: true });
  const response = await fixture.request('POST', '/flow', { body: publication });

  assert.deepEqual(response, {
    status: 503,
    body: Result.fail('媒体上传和文章发布正在进行短时维护，请稍后重试', 503),
  });
  assert.deepEqual(fixture.statusCalls, []);
  assert.deepEqual(fixture.createCalls, []);
});
