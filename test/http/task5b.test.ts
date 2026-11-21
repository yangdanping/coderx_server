import { Pool } from 'pg';
import jsonwebtoken from 'jsonwebtoken';
import { routers } from '../support/http-route-inventory.js';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startServer } from '../../src/hono.bootstrap.js';
import { createHttpApp } from '../../src/http/app.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { registerCollectRoutes } from '../../src/router/collect.router.js';
import { registerHistoryRoutes } from '../../src/router/history.router.js';
import { registerNotificationRoutes } from '../../src/router/notification.router.js';
import { registerTagRoutes } from '../../src/router/tag.router.js';
import { createAuthService } from '../../src/service/auth/auth.service.js';
import { createCollectService } from '../../src/service/collect/collect.service.js';
import { createHistoryService } from '../../src/service/history/history.service.js';
import { createNotificationService } from '../../src/service/notification.factory.js';
import { createTagService } from '../../src/service/tag/tag.service.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const { sign } = jsonwebtoken as {
  sign(payload: object, key: string, options: { algorithm: 'RS256' }): string;
};
const authorization = `Bearer ${sign({ id: '007' }, keys.privateKey, { algorithm: 'RS256' })}`;

type Query = [pattern: RegExp, params: readonly unknown[], result?: unknown[] | number | Error];

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coderx-task5b-'));
  const environment = {
    CODERX_TEST_RESOURCE_ROOT: root,
    JWT_PRIVATE_KEY_PATH: join(root, 'private.pem'),
    JWT_PUBLIC_KEY_PATH: join(root, 'public.pem'),
    MEDIA_ROOT: join(root, 'media'),
    LOG_ROOT: join(root, 'logs'),
    APP_ENV_FILE: join(root, '.env'),
    APP_HOST: '127.0.0.1',
    APP_PORT: '0',
    PUBLIC_API_ORIGIN: 'https://api.example.test///',
    FRONTEND_URL: 'https://frontend.example.test///',
    BACKGROUND_JOBS_ENABLED: 'false',
    DATABASE_URL: 'postgresql://test@postgres.example.invalid/test',
    NODE_ENV: 'production',
  };
  const names = new Set([...Object.keys(environment), ...Object.keys(process.env).filter(key => /^(?:PG|REDIS_)/.test(key))]);
  const previous = new Map(Array.from(names, key => [key, process.env[key]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, environment);
  writeFileSync(environment.JWT_PRIVATE_KEY_PATH, keys.privateKey);
  writeFileSync(environment.JWT_PUBLIC_KEY_PATH, keys.publicKey);
  writeFileSync(environment.APP_ENV_FILE, '');

  const queries: Query[] = [];
  let queryError: unknown;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const poolEnded = new Promise<void>(resolve => {
    const end: (this: Pool) => Promise<void> = Pool.prototype.end;
    t.mock.method(Pool.prototype, 'end', async function (this: Pool) {
      try { await end.call(this); } finally { resolve(); }
    });
  });
  t.after(async () => {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
        await poolEnded;
      }
      if (queryError) throw queryError;
      assert.deepEqual(queries, [], 'every expected SQL operation ran');
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  t.mock.method(Pool.prototype, 'query', async (sql: string, params: unknown[]) => {
    let result: Query[2];
    try {
      const expected = queries.shift();
      assert.ok(expected, `unexpected SQL: ${sql}`);
      assert.match(sql.trim(), expected[0]);
      assert.deepEqual(params, expected[1]);
      result = expected[2];
    } catch (error) {
      queryError = error;
      throw error;
    }
    if (result instanceof Error) throw result;
    const command = sql.trim().split(/\s+/, 1)[0];
    const rows = Array.isArray(result) ? result : [];
    return { command, rows, fields: [], rowCount: typeof result === 'number' ? result : rows.length };
  });
  server = await startServer();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const send = (method: string, path: string, body?: object, auth = authorization) => new Promise<{
    status: number | undefined; contentType?: string; length?: string; allow?: string; body: string;
  }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { connection: 'close' };
    if (auth) headers.authorization = auth;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = request({
      host: '127.0.0.1', port: address.port, method, path, headers, signal: AbortSignal.timeout(2000),
    }, res => {
      let content = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { content += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'],
        length: res.headers['content-length'],
        allow: res.headers.allow,
        body: content,
      }));
    });
    req.once('error', reject);
    req.end(payload);
  });
  return { send, queries };
}

const success = (data: unknown) => ({ data, code: 0 });
const failure = (msg: string, code = -1) => ({ msg, code });
const mutation = (command: string, count = 1, insertId = 0) => ({
  affectedRows: count, changedRows: count, insertId, rowCount: count, command,
});

function expectJson(response: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['send']>>, status: number, data: unknown, head = false) {
  const json = JSON.stringify(data);
  assert.equal(response.status, status);
  assert.equal(response.contentType, 'application/json; charset=utf-8');
  assert.equal(response.length, String(Buffer.byteLength(json)));
  assert.equal(response.body, head ? '' : json);
}

test('Task 5B candidate routes cover the 19 frozen Koa registrations', () => {

  const unavailable = async () => assert.fail('route inventory must stay off the database');
  const connection = { execute: unavailable, getConnection: unavailable, end: unavailable };
  const { verifyAuth, verifyPermission } = createAuthMiddleware({ publicKey: keys.publicKey, ...createAuthService(connection) });
  const candidate = createHttpApp({
    buildId: 'task5b-inventory',
    checkReady: async () => false,
    registerRoutes(app) {
      registerTagRoutes(app, { service: createTagService(connection), verifyAuth });
      registerHistoryRoutes(app, { service: createHistoryService(connection, '', ''), verifyAuth });
      registerCollectRoutes(app, { service: createCollectService(connection), verifyAuth, verifyPermission });
      registerNotificationRoutes(app, { service: createNotificationService(connection, ''), verifyAuth });
    },
  });
  for (const [group, count] of [['tag', 4], ['history', 5], ['collect', 6], ['notification', 4]] as const) {
    const entries = routers[`src/router/${group}.router.js`];
    assert.equal(entries.length, count);
    const expected = entries.flatMap(({ path, methods }) => methods.filter(method => method !== 'HEAD')
      .map(method => `${method} ${path}`));
    const actual = candidate.routes
      .filter(({ path }) => path === `/${group}` || path.startsWith(`/${group}/`))
      .map(({ method, path }) => `${method} ${path}`);
    assert.deepEqual([...new Set(actual)].sort(), expected.sort());
  }
});

test('Task 5B guarded routes require the JWT before touching PostgreSQL', async t => {
  const { send } = await fixture(t);
  const protectedRoutes = [
    ['POST', '/tag'], ['GET', '/tag/order'], ['PUT', '/tag/order'],
    ['POST', '/history'], ['GET', '/history'], ['DELETE', '/history/12'], ['DELETE', '/history'], ['GET', '/history/12/check'],
    ['POST', '/collect'], ['POST', '/collect/7'], ['PATCH', '/collect/7'], ['DELETE', '/collect/7'], ['DELETE', '/collect/7/articles'],
    ['GET', '/notification'], ['GET', '/notification/unread-count'], ['PATCH', '/notification/read-all'], ['PATCH', '/notification/12/read'],
  ];
  for (const [method, path] of protectedRoutes) {
    await t.test(`${method} ${path}`, async () => {
      for (const token of ['', 'Bearer invalid']) {
        expectJson(await send(method, path, undefined, token), 401, failure('未认证/token无效', 401));
      }
    });
  }
});

test('history exposes scoped writes and the original one-pass article ID decoding', async t => {
  const { send, queries } = await fixture(t);
  queries.push(
    [/INSERT INTO article_history[\s\S]+ON CONFLICT \(user_id, article_id\) DO UPDATE/, ['007', 12], 1],
    [/^SELECT id FROM article_history[\s\S]+WHERE user_id = \$1 AND article_id = \$2/, ['007', 'AbC%2F'], [{ id: 9 }]],
    [/^DELETE FROM article_history[\s\S]+WHERE user_id = \$1 AND article_id = \$2/, ['007', '1/2'], 1],
    [/^DELETE FROM article_history WHERE user_id = \$1;/, ['007'], 2],
  );
  expectJson(await send('POST', '/history/', { articleId: 12, userId: 99 }), 200, success(mutation('INSERT')));
  expectJson(await send('GET', '/HiStOrY/AbC%252F/ChEcK/'), 200, success({ hasViewed: true }));
  expectJson(await send('DELETE', '/HiStOrY/1%2F2/'), 200, success(mutation('DELETE')));
  expectJson(await send('DELETE', '/history'), 200, success(mutation('DELETE', 2)));
  assert.equal((await send('GET', '/history/1/%63heck')).status, 404);
  assert.equal((await send('GET', '/a/../history')).status, 404);
});

test('history listing preserves raw pagination and serializes preview, bans, totals, and dates', async t => {
  const { send, queries } = await fixture(t);
  const date = new Date('2026-11-15T00:00:00.000Z');
  const list = [
    { status: 0, excerpt: '中'.repeat(55), createAt: date, author: { id: 9, avatarUrl: 'http://legacy.example.test/user/9/avatar' } },
    { status: 1, title: 'private title', excerpt: 'private excerpt' },
    { status: null, excerpt: null },
  ];
  const result = [
    { status: 0, excerpt: '中'.repeat(50), createAt: date, author: { id: 9, avatarUrl: 'https://api.example.test/user/9/avatar' } },
    { status: 1, title: '文章已被封禁', excerpt: '文章已被封禁' },
    { status: null, excerpt: '' },
  ];
  const cases = [
    ['', undefined, undefined, null, null],
    ['?offset=5&limit=0', '5', '0', null, 0],
    ['?offset=1&offset=2&limit=2', ['1', '2'], '2', null, 2],
    ['?offset=20&limit=10', '20', '10', 3, 10],
  ] as const;
  for (const [search, offset, limit, pageNum, pageSize] of cases) {
    queries.push(
      [/https:\/\/api\.example\.test\/article\/images\/[\s\S]+https:\/\/frontend\.example\.test\/article\/[\s\S]+LIMIT \$2 OFFSET \$3/, ['007', limit, offset], structuredClone(list)],
      [/SELECT COUNT\(\*\) as total[\s\S]+WHERE ah.user_id = \$1/, ['007'], [{ total: '3' }]],
    );
    expectJson(await send('GET', `/HiStOrY/${search}`), 200, success({ result, total: '3', pageNum, pageSize }));
  }
});

const ownership = /^SELECT \* FROM collect WHERE id = \$1 AND user_id = \$2;/;
const nameLookup = /^SELECT \* FROM collect WHERE user_id = \$1 and name = \$2;/;
const batchDelete = /^DELETE FROM article_collect WHERE collect_id = \$1 AND article_id IN \(\$2,\$3\);/;
const remainingArticles = /^SELECT[\s\S]+jsonb_agg\(ac.article_id\)[\s\S]+WHERE ac.collect_id = \$1/;
const owned = [{ id: 7, user_id: '007' }];

test('public collection GET and owner-only mutations bind different parameter names on the same path shape', async t => {
  const { send, queries } = await fixture(t);
  const rows = [{ id: 7, name: '收藏', userId: 'AbC', createAt: '2026-11-15T00:00:00.000Z', count: null }];
  queries.push(
    [/FROM collect c[\s\S]+LIMIT \$2 OFFSET \$3/, ['AbC', '5', '10'], rows],
    [/FROM collect c[\s\S]+LIMIT \$2 OFFSET \$3/, ['AbC', '10', '0'], rows],
    [ownership, ['1.5', '007'], owned],
    [/DELETE FROM article_collect WHERE article_id = \$1 AND collect_id = \$2/, [12, 2], 0],
    [/INSERT INTO article_collect \(article_id, collect_id\) VALUES \(\$1, \$2\)/, [12, 2], 1],
    [ownership, ['7', '007'], owned],
    [/DELETE FROM article_collect WHERE article_id = \$1 AND collect_id = \$2/, [12, 7], 1],
    [ownership, ['7', '007'], owned],
    [/UPDATE collect SET name = \$1 WHERE id = \$2/, ['新名称', '7'], 1],
    [ownership, ['7', '007'], owned],
    [/^DELETE FROM article_collect WHERE collect_id = \$1;/, ['7'], 2],
    [/^DELETE FROM collect WHERE id = \$1;/, ['7'], 1],
  );
  expectJson(await send('GET', '/CoLLeCt/AbC/?pageNum=3&pageSize=5', undefined, ''), 200, success(rows));
  expectJson(await send('HEAD', '/CoLLeCt/AbC/', undefined, ''), 200, success(rows), true);
  expectJson(await send('POST', '/COLLECT/1.5/', { articleId: 12 }), 200, success({ isCollected: true, action: 'collected' }));
  expectJson(await send('POST', '/collect/7', { articleId: 12 }), 200, success({ isCollected: false, action: 'uncollected' }));
  expectJson(await send('PATCH', '/collect/7?userId=99', { name: '新名称' }), 200, success(mutation('UPDATE')));
  expectJson(await send('DELETE', '/collect/7'), 200, success(mutation('DELETE')));
  assert.equal((await send('OPTIONS', '/collect/7')).allow, 'POST, HEAD, GET, PATCH, DELETE');
});

test('creating a collection checks the caller’s existing name before insertion', async t => {
  const { send, queries } = await fixture(t);
  queries.push(
    [nameLookup, ['007', 'AlPhA'], [{ name: 'alpha' }]],
    [nameLookup, ['007', ' 收藏 '], []],
    [/^INSERT INTO collect \(user_id,name\) VALUES \(\$1,\$2\) RETURNING id;/, ['007', ' 收藏 '], [{ id: 19 }]],
  );
  expectJson(await send('POST', '/collect', { name: 'AlPhA' }), 409, failure('命名已存在', 409));
  expectJson(await send('POST', '/collect', { name: ' 收藏 ', userId: 99 }), 200, success(mutation('INSERT', 1, 19)));
});

test('collection permission denial and lookup failure stop before conversion, validation, and writes', async t => {
  const { send, queries } = await fixture(t);
  for (const [method, path, id] of [
    ['POST', '/collect/7', '7'], ['PATCH', '/collect/7', '7'],
    ['DELETE', '/collect/7', '7'], ['DELETE', '/collect/01/articles?idList=invalid', '01'],
  ]) {
    queries.push([ownership, [id, '007'], []]);
    expectJson(await send(method, path, { userId: 99 }), 403, failure('不具备操作的权限', 403));
  }
  queries.push([ownership, ['7', '007'], new Error('fixture query failed')]);
  expectJson(await send('DELETE', '/collect/7/articles?idList=invalid'), 403, failure('不具备操作的权限', 403));
});

test('permitted collection batch removal validates IDs and returns the remaining aggregate', async t => {
  const { send, queries } = await fixture(t);
  for (const id of ['0', '01', '1.5', '1e2', '9007199254740993']) {
    queries.push([ownership, [id, '007'], owned]);
    expectJson(await send('DELETE', `/collect/${id}/articles?idList=%5B12%5D`), 200, failure('收藏夹 ID 参数错误'));
  }
  for (const query of ['', '?idList=%7B%7D', '?idList=%5B0%5D', '?idList=%5B%2212%22%5D', '?idList=%5B9007199254740993%5D', '?idList=%5B1%5D&idList=%5B2%5D']) {
    queries.push([ownership, ['7', '007'], owned]);
    expectJson(await send('DELETE', `/collect/7/articles${query}`), 200, failure('文章 ID 参数错误'));
  }
  queries.push(
    [ownership, ['7', '007'], owned],
    [batchDelete, [7, 11, 12], 2],
    [remainingArticles, [7], [{ collectedArticle: [31] }]],
    [ownership, ['7', '007'], owned],
    [batchDelete, [7, 11, 12], 2],
    [remainingArticles, [7], [{ collectedArticle: [31] }]],
    [ownership, ['7', '007'], owned],
    [remainingArticles, [7], [{ collectedArticle: null }]],
  );
  expectJson(await send('DELETE', '/CoLLeCt/7/ArTiClEs/?idList=%5B11,12%5D'), 200, success({ collectedArticle: [31] }));
  expectJson(await send('DELETE', '/collect/7/articles?idList=%5B11&idList=12%5D'), 200, success({ collectedArticle: [31] }));
  expectJson(await send('DELETE', '/collect/7/articles?idList=%5B%5D'), 200, success({ collectedArticle: null }));
});

test('notification listing preserves recipient identity, page coercion, ordering, and hydrated avatar URLs', async t => {
  const { send, queries } = await fixture(t);
  const notification = {
    id: 12, recipientId: 7, actor: { id: 9, avatarUrl: 'http://legacy.example.test/user/9/avatar' }, readAt: null,
  };
  const list = /FROM notifications n[\s\S]+WHERE n.recipient_id = \$1[\s\S]+ORDER BY n.created_at DESC[\s\S]+LIMIT \$2 OFFSET \$3/;
  queries.push(
    [list, ['007', '10', '0'], [structuredClone(notification)]],
    [list, ['007', '4', '8'], []],
    [list, ['007', '10', '0'], []],
  );
  expectJson(await send('GET', '/NoTiFiCaTiOn/?recipientId=99'), 200, success([{
    ...notification, actor: { id: 9, avatarUrl: 'https://api.example.test/user/9/avatar' },
  }]));
  expectJson(await send('GET', '/notification?pageNum=3&pageSize=4'), 200, success([]));
  expectJson(await send('HEAD', '/notification?offset=1&offset=2&limit=oops'), 200, success([]), true);
});

test('notification count and idempotent read mutations stay scoped to the JWT recipient', async t => {
  const { send, queries } = await fixture(t);
  const count = /SELECT COUNT\(\*\)::bigint AS count[\s\S]+WHERE recipient_id = \$1 AND read_at IS NULL/;
  queries.push(
    [count, ['007'], [{ count: '3' }]],
    [count, ['007'], []],
    [/UPDATE notifications[\s\S]+SET read_at = COALESCE\(read_at, now\(\)\)[\s\S]+WHERE id = \$1 AND recipient_id = \$2/, ['AbC', '007'], 0],
    [/UPDATE notifications[\s\S]+SET read_at = COALESCE\(read_at, now\(\)\)[\s\S]+WHERE recipient_id = \$1 AND read_at IS NULL/, ['007'], 2],
  );
  expectJson(await send('GET', '/notification/unread-count?recipientId=99'), 200, success({ count: 3 }));
  expectJson(await send('HEAD', '/notification/unread-count/'), 200, success({ count: 0 }), true);
  expectJson(await send('PATCH', '/NoTifIcAtIoN/AbC/ReAd/', { recipientId: 99 }), 200, success(mutation('UPDATE', 0)));
  expectJson(await send('PATCH', '/notification/read-all', { recipientId: 99 }), 200, success(mutation('UPDATE', 2)));
});

test('tag collection and order retain Koa JSON headers on HEAD', async t => {
  const { send, queries } = await fixture(t);
  const rows = [{ id: 7, name: '标签' }];
  queries.push(
    [/^SELECT \* FROM tag ORDER BY id ASC LIMIT \$1 OFFSET \$2;/, ['99', '0'], rows],
    [/LEFT JOIN user_tag_preference[\s\S]+utp.user_id = \$1/, ['007'], rows],
  );
  expectJson(await send('HEAD', '/TaG/', undefined, ''), 200, success(rows), true);
  expectJson(await send('HEAD', '/TaG/OrDeR/'), 200, success(rows), true);
  assert.equal((await send('OPTIONS', '/tag/')).allow, 'POST, HEAD, GET');
});

test('Task 5B preserves Koa method negotiation and unmatched-path headers', async t => {
  const { send } = await fixture(t);
  const cases = [
    ['OPTIONS', '/HiStOrY/', 200, 'POST, HEAD, GET, DELETE', ''],
    ['PATCH', '/history', 405, 'POST, HEAD, GET, DELETE', 'Method Not Allowed'],
    ['PROPFIND', '/history', 501, 'POST, HEAD, GET, DELETE', 'Not Implemented'],
    ['POST', '/history/1/check', 405, 'HEAD, GET', 'Method Not Allowed'],
    ['GET', '/collect/01/articles', 405, 'DELETE', 'Method Not Allowed'],
    ['GET', '/%68istory', 404, undefined, 'Not Found'],
    ['GET', '/history/1/%63heck', 404, undefined, 'Not Found'],
  ] as const;
  for (const [method, path, status, allow, body] of cases) {
    assert.deepEqual(await send(method, path), {
      status, allow, body, contentType: 'text/plain; charset=utf-8', length: String(Buffer.byteLength(body)),
    }, `${method} ${path}`);
  }
});
