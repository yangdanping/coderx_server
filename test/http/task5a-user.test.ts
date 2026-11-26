import { routers } from '../support/http-route-inventory.js';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import { createHttpApp, type HttpAppOptions } from '../../src/http/app.js';
import { createVerifyAuth } from '../../src/middleware/auth.middleware.js';
import { registerOAuthRoutes } from '../../src/router/oauth.router.js';
import { registerUserRoutes } from '../../src/router/user.router.js';
import { createAvatarLookup } from '../../src/service/avatar/avatar.service.js';
import { createOAuthService } from '../../src/service/oauth/oauth.service.js';
import { createUserService } from '../../src/service/user.factory.js';
import { createSignUserToken } from '../../src/service/user/userToken.service.js';
import { hashPwd, comparePwd } from '../../src/utils/password.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signToken = createSignUserToken(keys.privateKey);
const authorization = `Bearer ${signToken({ id: 7, name: 'fixture' })}`;

const credential = 'isolated-fixture-password';
const passwordHash = hashPwd(credential);
const publicApiOrigin = 'https://api.example.test';
const fixtureWrite = { affectedRows: 1, changedRows: 0, insertId: 21, rowCount: 1, command: 'INSERT' };

function createFixture(avatarRoot = '', queryFailure?: Error, logRequest?: HttpAppOptions['logRequest']) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const transaction: string[] = [];
  const stamp = new Date('2026-11-15T00:00:00.000Z');
  const account = { id: 7, name: 'fixture', password: passwordHash, email: 'fixture@example.test' };
  const publishFailure = new Error('Unexpected publish from fixture transaction');
  const database = {
    async execute(sql: string, params: unknown[] = []): Promise<[result: unknown, fields: unknown]> {
      queries.push({ sql, params });
      if (queryFailure) throw queryFailure;
      if (sql.startsWith('SELECT * FROM "user" WHERE name =')) return [params[0] === 'fixture' ? [account] : [], []];
      if (sql.includes('articleCount')) return [params[0] === 'missing' ? [] : [{ id: params[0], nickname: null, articleCount: 3 }], []];
      if (sql.startsWith('UPDATE profile')) return [fixtureWrite, []];
      if (sql.includes('FROM article_collect')) return [[{ id: 3, title: 'Post', excerpt: null, createAt: stamp }], []];
      if (sql.includes('FROM comment c')) return [[{ id: 4, content: '<p>Text&nbsp;&amp; content</p>', createAt: stamp, likes: 2 }], []];
      if (sql.includes('"articleLiked"')) return [params[0] === '8' ? [] : [{ id: 7, articleLiked: null, commentLiked: [50] }], []];
      if (sql.includes('FROM user_follow uf')) return [[{ id: 7, following: null, follower: [{ id: 2, avatarUrl: '/dev-api/user/2/avatar' }] }], []];
      if (sql.includes('"articleInfo"')) return [[{ id: 7, avatarUrl: '/user/7/avatar', articleInfo: { totalLikes: 4, totalViews: null } }], []];
      if (sql.startsWith('INSERT INTO report')) return [fixtureWrite, []];
      if (sql.startsWith('SELECT * FROM avatar')) return [params[0] === '7'
        ? [{ filename: 'previous.png', mimetype: 'image/png' }, { filename: 'fixture.png', mimetype: 'image/png' }]
        : [], []];
      throw new Error(`Unexpected fixture query ${sql}`);
    },
    async getConnection() {
      return {
        async execute(sql: string, params: unknown[] = []): Promise<[result: unknown, fields: unknown]> {
          queries.push({ sql, params });
          transaction.push('execute');
          assert.match(sql, /^(?:INSERT INTO (?:"user"|profile)|DELETE FROM user_follow)/);
          return [fixtureWrite, []];
        },
        async beginTransaction() { transaction.push('begin'); },
        async commit() { transaction.push('commit'); },
        async rollback() { transaction.push('rollback'); },
        release() { transaction.push('release'); },
      };
    },
    async end() {},
  };
  const service = createUserService({
    connection: database,
    baseURL: publicApiOrigin,
    notificationService: { async createFollowNotification() { throw publishFailure; } },
    async publishNotificationCreated() { throw publishFailure; },
  });
  const app = createHttpApp({
    buildId: 'user-fixture',
    logRequest,
    checkReady: async () => false,
    registerRoutes(app) {
      registerUserRoutes(app, {
        service, getAvatarById: createAvatarLookup(database),
        avatarRoot, signToken, verifyAuth: createVerifyAuth(keys.publicKey),
      });
    },
  });
  return { app, queries, service, transaction, stamp: stamp.toISOString() };
}

function json(method: string, value: unknown, authorized = false): RequestInit {
  return {
    method, body: JSON.stringify(value),
    headers: { 'Content-Type': 'application/json', ...(authorized ? { authorization } : {}) },
  };
}

async function assertJson(response: Response, status: number, expected: unknown) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  assert.deepEqual(await response.json(), expected);
}

test('Task 5A candidate paths cover the frozen 13 user and 6 OAuth registrations', () => {

  const oauthApp = createHttpApp({
    buildId: 'oauth-inventory',
    checkReady: async () => false,
    registerRoutes(app) {
      registerOAuthRoutes(app, {
        service: createOAuthService({
          async execute() { throw new Error('Inventory should not query the database'); },
          async getConnection() { throw new Error('Inventory should not start a transaction'); },
        }, { env: {} }),
        signToken, frontendUrl: undefined, googleClientId: undefined,
      });
    },
  });
  for (const [group, candidate, count] of [
    ['user', createFixture().app, 13],
    ['oauth', oauthApp, 6],
  ] as const) {
    const entries = routers[`src/router/${group}.router.js`];
    assert.equal(entries.length, count);
    const actual = candidate.routes
      .filter(route => route.path.startsWith(`/${group}/`))
      .map(route => `${route.method} ${route.path}`);
    const candidatePaths = { '/user/checkAuth': '/user/checkauth' } as Record<string, string>;
    const expected = entries.flatMap(entry => entry.methods
      .filter(method => method !== 'HEAD') // Hono supplies HEAD for each registered GET.
      .map(method => `${method} ${candidatePaths[entry.path] ?? entry.path}`));
    assert.deepEqual([...new Set(actual)].sort(), expected.sort());
  }
});

test('registration preserves validation order, nickname normalization, bcrypt and transaction results', async () => {
  const { app, queries, transaction } = createFixture();
  const request = (value: unknown) => app.request('/user/register', json('POST', value));
  await assertJson(await request({ password: credential }), 400, { msg: '用户名或密码输入不正确', code: 400 });
  await assertJson(await request({ name: 'fixture', password: credential, nickname: 'invalid\nline' }), 400, {
    msg: '昵称须为 1-30 个字符，且不能包含换行或控制字符', code: 400,
  });
  assert.equal(queries.length, 0);
  await assertJson(await request({ name: 'fixture', password: credential }), 409, { msg: '用户名已存在', code: 409 });
  assert.equal(queries.length, 1);
  await assertJson(await request({ name: 'new-account', password: credential, nickname: '  小杨  ' }), 200, { data: fixtureWrite, code: 0 });
  assert.deepEqual(transaction, ['begin', 'execute', 'execute', 'commit', 'release']);
  assert.equal(queries[2].params[0], 'new-account');
  const hash = queries[2].params[1];
  assert.equal(typeof hash, 'string');
  assert.match(String(hash), /^\$2[aby]\$10\$/);
  assert.ok(comparePwd(credential, hash));
  assert.deepEqual(queries[3].params, [21, '小杨']);
  await assertJson(await request({ name: 'missing-nickname', password: credential }), 200, { data: fixtureWrite, code: 0 });
  assert.deepEqual(queries[6].params, [21, null]);
  await assertJson(await request({ name: 'blank-nickname', password: credential, nickname: '   ' }), 200, { data: fixtureWrite, code: 0 });
  assert.deepEqual(queries[9].params, [21, null]);
});

test('login keeps failure codes, form parsing, exact signed claims and HEAD checkAuth', async () => {
  const { app } = createFixture();
  const request = (value: unknown) => app.request('/user/login', json('POST', value));
  await assertJson(await request({}), 400, { msg: '用户名或密码输入不正确', code: 400 });
  await assertJson(await request({ name: 'missing', password: credential }), 404, { msg: '用户不存在,请注册', code: 404 });
  await assertJson(await request({ name: 'fixture', password: 'wrong' }), 400, { msg: '用户密码错误', code: 400 });
  const form = `name=fixture&password=${credential}`;
  const login = await app.request('/USER/LOGIN/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(form)) },
    body: form,
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await login.json();
  const { token } = body.data;
  assert.deepEqual(body, { data: { id: 7, name: 'fixture', token }, code: 0 });
  const result = jwt.verify(token, keys.publicKey, { algorithms: ['RS256'], complete: true });
  assert.deepEqual(result.header, { alg: 'RS256', typ: 'JWT' });
  const { payload } = result;
  assert.ok(typeof payload === 'object' && typeof payload.iat === 'number');
  assert.deepEqual(payload, { id: 7, name: 'fixture', iat: payload.iat, exp: payload.iat + 604800 });
  const expired = jwt.sign({ id: 7 }, keys.privateKey, { algorithm: 'RS256', expiresIn: -1 });
  for (const authorization of [undefined, 'Bearer invalid', `Bearer ${expired}`]) {
    await assertJson(await app.request('/user/checkAuth', { headers: authorization ? { authorization } : {} }),
      401, { msg: '未认证/token无效', code: 401 });
  }
  for (const authorization of [token, `Bearer ${token}`]) {
    await assertJson(await app.request('/user/checkAuth', { headers: { authorization } }), 200, { code: 0 });
  }
  const head = await app.request('/user/cHeCkAuTh/', { method: 'HEAD', headers: { authorization: token } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});

test('registration and login omit credentials, password hashes and issued tokens from logs', async t => {
  const messages: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { messages.push(args); });
  }
  const { app, queries } = createFixture('', undefined, record => messages.push(record));
  for (const path of ['/user/login', '/user/register']) {
    const rejected = await app.request(path, json('POST', { password: credential }));
    assert.equal(rejected.status, 400);
  }
  const login = await app.request('/user/login', json('POST', { name: 'fixture', password: credential }));
  assert.equal(login.status, 200);
  const { data: { token } } = await login.json() as { data: { token: string } };
  const registered = await app.request('/user/register', json('POST', { name: 'new-account', password: credential }));
  assert.equal(registered.status, 200);
  const hash = queries.find(query => query.sql.startsWith('INSERT INTO "user"'))?.params[1];
  assert.ok(typeof hash === 'string' && comparePwd(credential, hash));
  const output = inspect(messages, { depth: null });
  for (const secret of [credential, passwordHash, hash, token]) assert.ok(!output.includes(secret));
  assert.ok(messages.length > 0, 'request logging is enabled');
});

test('profile reads retain raw parameter matching and omitted data, and updates use the JWT user', async () => {
  const { app, queries } = createFixture();
  for (const [path, id] of [
    ['/UsEr/AbC/PrOfIlE/', 'AbC'], ['/user/a%2Fb/profile', 'a/b'],
    ['/user/a%252Fb/profile', 'a%2Fb'], ['/user/%ZZ%2F/profile', '%ZZ%2F'],
  ]) {
    await assertJson(await app.request(path), 200, { data: { id, nickname: null, articleCount: 3 }, code: 0 });
    assert.deepEqual(queries.at(-1)?.params, [id]);
  }
  for (const path of ['/%75ser/7/profile', '/user/7/%70rofile', '/user/7/profile//']) {
    const response = await app.request(path);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not Found');
  }
  await assertJson(await app.request('/user/missing/profile'), 200, { code: 0 });
  await assertJson(await app.request('/user/profile', json('PUT', { age: 0 })), 401, { msg: '未认证/token无效', code: 401 });
  await assertJson(await app.request('/user/profile', json('PUT', { wrong: null }, true)), 400, { msg: '个人资料字段不受支持', code: 400 });
  await assertJson(await app.request('/user/profile', json('PUT', {}, true)), 200, { data: null, code: 0 });
  await assertJson(await app.request('/user/profile', json('PUT', { nickname: '   ', age: 0 }, true)), 200, { code: 0, data: fixtureWrite });
  assert.deepEqual(queries.at(-1)?.params, [null, 0, 7]);
});

test('collection and comment reads preserve repeated queries, pagination and serialization', async () => {
  const { app, queries, stamp } = createFixture();
  await assertJson(await app.request('/user/007/collect?collectId=a&collectId=b&pageNum=2&pageSize=3'), 200, {
    data: [{ id: 3, title: 'Post', excerpt: null, createAt: stamp }], code: 0,
  });
  assert.deepEqual(queries.at(-1)?.params, ['007', ['a', 'b'], '3', '3']);
  await assertJson(await app.request('/user/7/comment?pageSize=0&limit=0'), 200, {
    data: [{ id: 4, content: 'Text & content', createAt: stamp, likes: 2 }], code: 0,
  });
  assert.deepEqual(queries.at(-1)?.params, ['7', '0', '0']);
  await assertJson(await app.request('/user/7/comment?offset=-3&offset=2&limit=7'), 200, {
    data: [{ id: 4, content: 'Text & content', createAt: stamp, likes: 2 }], code: 0,
  });
  assert.deepEqual(queries.at(-1)?.params, ['7', '7', '0']);
});

test('like, follow and hot reads preserve null values, empty fallback and public avatar URLs', async () => {
  const { app, queries, transaction } = createFixture();
  await assertJson(await app.request('/user/not-a-number/like'), 200, { data: { articleLiked: [], commentLiked: [] }, code: 0 });
  assert.equal(queries.length, 0);
  await assertJson(await app.request('/user/007/like'), 200, { data: { id: 7, articleLiked: null, commentLiked: [50] }, code: 0 });
  assert.deepEqual(queries.at(-1)?.params, ['007']);
  await assertJson(await app.request('/user/7/follow'), 200, {
    data: { id: 7, following: null, follower: [{ id: 2, avatarUrl: `${publicApiOrigin}/user/2/avatar` }] }, code: 0,
  });
  await assertJson(await app.request('/user/hot/'), 200, { data: [
    { id: 7, avatarUrl: `${publicApiOrigin}/user/7/avatar`, articleInfo: { totalLikes: 4, totalViews: null } },
  ], code: 0 });
  const options = await app.request('/uSeR/AbC/fOlLoW/', { method: 'OPTIONS' });
  assert.equal(options.status, 200);
  assert.equal(options.headers.get('allow'), 'HEAD, GET, POST');
  assert.equal(await options.text(), '');
  const mismatch = await app.request('/user/7/follow', { method: 'PUT' });
  assert.equal(mismatch.status, 405);
  assert.equal(mismatch.headers.get('allow'), 'HEAD, GET, POST');
  await assertJson(await app.request('/user/7/follow', json('POST', {}, true)), 500, { msg: '服务器内部错误', code: 500 });
  assert.deepEqual(transaction, []);
  await assertJson(await app.request('/user/8/follow', json('POST', { followerId: 100 }, true)), 200, {
    data: { isFollowed: false, action: 'unfollowed', notificationCreated: false, notification: null }, code: 0,
  });
  assert.deepEqual(queries.at(-1)?.params, ['8', 7]);
  assert.deepEqual(transaction, ['begin', 'execute', 'commit', 'release']);
});

test('reports honor auth ordering and use the legacy target and option branches', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const { app, queries } = createFixture();
  await assertJson(await app.request('/user/17/report', json('POST', {})), 401, { msg: '未认证/token无效', code: 401 });
  assert.equal(queries.length, 0);
  await assertJson(await app.request('/user/17tail/report', json('POST', { reportOptions: ['a', 'b'], articleId: 20, commentId: 0 }, true)), 200, {
    data: fixtureWrite, code: 0,
  });
  assert.match(queries.at(-1)?.sql ?? '', /article_id/);
  assert.deepEqual(queries.at(-1)?.params, [17, 'a b', 20]);
  await assertJson(await app.request('/user/17/report', json('POST', { reportOptions: ['c', 'd'], articleId: 20, commentId: 21 }, true)), 200, {
    data: fixtureWrite, code: 0,
  });
  assert.match(queries.at(-1)?.sql ?? '', /comment_id/);
  assert.deepEqual(queries.at(-1)?.params, [17, 'c d', 21]);
  await assertJson(await app.request('/user/17/report', json('POST', { reportOptions: 'invalid' }, true)), 500, { msg: '服务器内部错误', code: 500 });
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [[queries[0].sql], [queries[1].sql]]);
});

test('user queries and report writes surface the original database failure to internal callers', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const failure = new Error('fixture database unavailable');
  const { service, queries } = createFixture('', failure);
  for (const operation of [
    () => service.getLikedById('7'),
    () => service.getFollowInfo('7'),
    () => service.getArticleByCollectId('7', '3', '0', '10'),
    () => service.userReport(7, 'fixture option', 20),
    () => service.getHotUsers(),
  ]) {
    await assert.rejects(operation, error => error === failure);
  }
  assert.equal(queries.length, 5);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [[queries[3].sql]]);
});

test('only failed user queries and report writes log while using the legacy omitted-data response', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const valid = createFixture();
  await assertJson(await valid.app.request('/user/8/like'), 200, { code: 0 });
  assert.equal(log.mock.callCount(), 0);

  const failure = new Error('fixture database unavailable');
  const { app, queries } = createFixture('', failure);
  for (const path of ['/user/7/like', '/user/7/follow', '/user/7/collect?collectId=3', '/user/hot']) {
    await assertJson(await app.request(path), 200, { code: 0 });
  }
  await assertJson(
    await app.request('/user/7/report', json('POST', { reportOptions: ['fixture option'], articleId: 20 }, true)),
    200,
    { code: 0 },
  );
  assert.equal(queries.length, 5);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [
    [failure], [failure], [failure], [failure], [queries[4].sql], [failure],
  ]);
});

test('avatar lookup uses the last metadata row, streams stored MIME and sees missing metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coderx-task5a-avatar-'));
  try {
    await writeFile(join(directory, 'fixture.png'), Buffer.from([5, 0, 10, 255]));
    const { app } = createFixture(directory);
    const photo = await app.request('/user/7/avatar', { headers: { Range: 'bytes=0-1' } });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), Uint8Array.from([5, 0, 10, 255]));
    const head = await app.request('/user/7/avatar', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'image/png');
    assert.equal(head.headers.get('content-length'), null);
    assert.equal(await head.text(), '');
    const absent = await app.request('/user/8/avatar');
    assert.equal(absent.status, 404);
    assert.equal(await absent.text(), 'Not Found');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('avatar response keeps file reads bounded and closes the file when cancelled', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coderx-task5a-avatar-cancel-'));
  const path = join(directory, 'fixture.png');
  const bytes = Buffer.alloc(1024 * 1024, 42);
  const createReadStream = fs.createReadStream;
  let file: fs.ReadStream | undefined;
  const open = t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof createReadStream>) => {
    const stream = createReadStream(...args);
    if (args[0] === path) file = stream;
    return stream;
  });
  syncBuiltinESMExports();

  try {
    await writeFile(path, bytes);
    const { app } = createFixture(directory);
    const photo = await app.request('/user/7/avatar');
    assert.equal(photo.status, 200);
    const opened = file;
    assert.ok(opened);
    const reader = photo.body?.getReader();
    assert.ok(reader);
    try {
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.deepEqual(first.value, new Uint8Array(bytes.subarray(0, opened.readableHighWaterMark)));
      await setImmediate();
      assert.ok(opened.bytesRead <= opened.readableHighWaterMark * 3);
    } finally {
      const closed = new Promise<void>(resolve => opened.once('close', resolve));
      await reader.cancel();
      await closed;
    }
    assert.equal(opened.closed, true);
    assert.ok(opened.bytesRead < bytes.length);
  } finally {
    file?.destroy();
    open.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});
