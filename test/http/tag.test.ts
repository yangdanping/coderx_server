import { observeImports } from '../support/observe-imports.js';
import jsonwebtoken from 'jsonwebtoken';
import { frozenHttpContract } from '../support/frozen-http-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { serve } from '@hono/node-server';
import { createHttpApp } from '../../src/http/app.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { registerTagRoutes } from '../../src/router/tag.router.js';
import { createTagService } from '../../src/service/tag/tag.service.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { sign } = jsonwebtoken as {
  sign(payload: object, key: typeof privateKey, options: { algorithm: 'RS256' }): string;
};
const token = sign({ id: '007' }, privateKey, { algorithm: 'RS256' });
const { verifyAuth } = createAuthMiddleware({
  publicKey,
  checkStatus: async () => assert.fail('Tags only require JWT verification'),
  checkPermission: async () => assert.fail('Tags only require JWT verification'),
});
const rows = [{ id: 3, name: 'JS/TS' }, { id: 1, name: '前端' }];
const insertResult = { affectedRows: 1, changedRows: 1, insertId: 21, rowCount: 1, command: 'INSERT' };

function fixture(options: { missingTag?: boolean; failInsert?: boolean } = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const events: string[] = [];
  const database = {
    async execute(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return [sql.startsWith('INSERT INTO tag') ? insertResult : rows, []] as const;
    },
    async getConnection() {
      events.push('acquire');
      return {
        async beginTransaction() { events.push('begin'); },
        async execute(sql: string, params: readonly unknown[]) {
          calls.push({ sql, params });
          if (sql.includes('SELECT id FROM tag')) {
            events.push('lookup');
            return [options.missingTag ? [{ id: 1 }] : [{ id: 1 }, { id: 3 }], []] as const;
          }
          if (sql.includes('DELETE FROM user_tag_preference')) {
            events.push('delete');
            return [{ affectedRows: 2, changedRows: 2, insertId: 0, rowCount: 2, command: 'DELETE' }, []] as const;
          }
          if (sql.includes('INSERT INTO user_tag_preference')) {
            events.push('insert');
            if (options.failInsert) throw new Error('fixture database failure');
            return [{ affectedRows: 2, changedRows: 2, insertId: 0, rowCount: 2, command: 'INSERT' }, []] as const;
          }
          assert.match(sql, /SELECT t\.id, t\.name/);
          events.push('read');
          return [rows, []] as const;
        },
        async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },
        release() { events.push('release'); },
      };
    },
  };
  const app = createHttpApp({
    buildId: 'tag-test',
    checkReady: async () => false,
    registerRoutes: app => {
      registerTagRoutes(app, { service: createTagService(database), verifyAuth });
    },
  });
  return { app, calls, events };
}

function json(method: string, body: object, authorization = `Bearer ${token}`): RequestInit {
  return { method, headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(body) };
}

async function assertJson(response: Response, status: number, value: unknown) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), value);
}

test('GET /tag preserves default, explicit, repeated and empty pagination values', async () => {
  const { app, calls } = fixture();
  for (const url of ['/tag', '/tag?offset=02&limit=+10', '/tag/?offset=1&offset=2&limit=9&limit=10', '/tag?offset=&limit=']) {
    await assertJson(await app.request(url), 200, { data: rows, code: 0 });
  }
  assert.deepEqual(calls.map(({ params }) => params), [['99', '0'], [' 10', '02'], [['9', '10'], ['1', '2']], ['', '']]);
  assert.equal(calls[0].sql, 'SELECT * FROM tag ORDER BY id ASC LIMIT ? OFFSET ?;');
  const head = await app.request('/tag', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const mismatch = await app.request('/tag', { method: 'PUT' });
  assert.equal(mismatch.status, 405);
  assert.equal(mismatch.headers.get('allow'), 'POST, HEAD, GET');
});

function rawRequest(port: number, path: string, method: string) {
  return new Promise<{ status: number | undefined; allow: string | undefined; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { authorization: token }, signal: AbortSignal.timeout(2000) }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, allow: response.headers.allow, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('tag path matching, methods and trailing slashes preserve legacy responses through the Node adapter', async t => {
  const { app, calls } = fixture();
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const honoAddress = server.address();
  const contract = frozenHttpContract('tag');
  assert.ok(honoAddress && typeof honoAddress !== 'string');
  const cases = [
    ['/TaG', 'GET'], ['/TAG/OrDeR/', 'GET'], ['/TAG', 'OPTIONS'], ['/TAG/OrDeR/', 'POST'], ['http://example.test/TaG?limit=99', 'GET'],
    ['/%74ag', 'GET'], ['/tag/%6Frder', 'GET'], ['/TAG//', 'GET'], ['/a/../tag', 'GET'], ['/a/%2e%2e/tag/order?userId=42', 'GET'],
    ['http://example.test/a/../tag', 'GET'], ['/tag', 'PROPFIND'], ['/tag/order/', 'PROPFIND'],
  ];
  for (const [path, method] of cases) {
    await t.test(`${method} ${path}`, async () => {
      contract.assert(method, path, await rawRequest(honoAddress.port, path, method));
    });
  }
  assert.equal(calls.length, 3);
  assert.equal((await rawRequest(honoAddress.port, '/HEALTH/LIVE', 'GET')).status, 404);
  assert.equal((await rawRequest(honoAddress.port, '/health/%6Cive', 'GET')).status, 200);
  assert.equal((await rawRequest(honoAddress.port, '/a/../health/live', 'GET')).status, 200);
  assert.equal((await rawRequest(honoAddress.port, '/health/live', 'PROPFIND')).status, 405);
  contract.assertComplete();
});

test('POST /tag preserves JSON and legacy form names and PG mutation metadata', async () => {
  const { app, calls } = fixture();
  await assertJson(await app.request('/tag', json('POST', { name: '  中文  ', extra: true }, token)), 200, { data: insertResult, code: 0 });
  const form = 'name=first&name=second';
  await assertJson(await app.request('/tag/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(form.length), authorization: token },
    body: form,
  }), 200, { data: insertResult, code: 0 });
  assert.deepEqual(calls, [
    { sql: 'INSERT INTO tag (name) VALUES (?) RETURNING id;', params: ['  中文  '] },
    { sql: 'INSERT INTO tag (name) VALUES (?) RETURNING id;', params: [['first', 'second']] },
  ]);
});

test('protected tag routes reject absent and invalid JWTs before accessing the database', async () => {
  const { app, calls, events } = fixture();
  for (const [path, method] of [['/tag', 'POST'], ['/tag/order', 'GET'], ['/tag/order', 'PUT']]) {
    for (const authorization of ['', 'Bearer invalid']) {
      await assertJson(await app.request(path, { method, headers: { authorization } }), 401, { msg: '未认证/token无效', code: 401 });
    }
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

test('GET and PUT /tag/order use the original token identity and a single replacement transaction', async () => {
  const { app, calls, events } = fixture();
  await assertJson(await app.request('/tag/order?userId=42', { headers: { authorization: `Bearer ${token}` } }), 200, { data: rows, code: 0 });
  await assertJson(await app.request('/tag/order/', json('PUT', { userId: 42, tagIds: [3, 1] })), 200, { data: rows, code: 0 });
  assert.deepEqual(events, ['acquire', 'begin', 'lookup', 'delete', 'insert', 'read', 'commit', 'release']);
  assert.deepEqual(calls.map(({ params }) => params), [['007'], [3, 1], ['007'], ['007', 3, 0, '007', 1, 1], ['007']]);
});

test('empty tag order clears preferences in one transaction', async () => {
  const { app, calls, events } = fixture();
  await assertJson(await app.request('/tag/order', json('PUT', { tagIds: [] })), 200, { data: rows, code: 0 });
  assert.deepEqual(events, ['acquire', 'begin', 'delete', 'read', 'commit', 'release']);
  assert.deepEqual(calls.map(({ params }) => params), [['007'], ['007']]);
});

test('invalid tag IDs fail before the database is accessed', async () => {
  const { app, calls, events } = fixture();
  for (const [tagIds, msg] of [
    [null, '标签顺序必须是数组'],
    [[1, '2'], '标签 ID 必须是正整数'],
    [[1, 1], '标签顺序不能包含重复项'],
  ] as const) {
    await assertJson(await app.request('/tag/order', json('PUT', { tagIds })), 400, { msg, code: 400 });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

test('missing tag IDs roll back and release before writes', async () => {
  const { app, events } = fixture({ missingTag: true });
  await assertJson(await app.request('/tag/order', json('PUT', { tagIds: [3, 1] })), 400, { msg: '标签不存在', code: 400 });
  assert.deepEqual(events, ['acquire', 'begin', 'lookup', 'rollback', 'release']);
});

test('insert failure after deletion rolls back, releases and preserves the production error envelope', async () => {
  const { app, events } = fixture({ failInsert: true });
  await assertJson(await app.request('/tag/order', json('PUT', { tagIds: [3, 1] })), 500, { msg: '服务器内部错误', code: 500 });
  assert.deepEqual(events, ['acquire', 'begin', 'lookup', 'delete', 'insert', 'rollback', 'release']);
});

test('tag router and service factory imports leave runtime dependencies unloaded', () => {
  const script = `
    ${observeImports}
    const { createTagService } = await import('./src/service/tag/tag.service.js');
    const { registerTagRoutes } = await import('./src/router/tag.router.js');
    const { createHttpApp } = await import('./src/http/app.js');
    const { createAuthMiddleware } = await import('./src/middleware/auth.middleware.js');
    const { verifyAuth } = createAuthMiddleware({ publicKey: '', checkStatus() {}, checkPermission() {} });
    createHttpApp({
      buildId: '',
      checkReady: async () => false,
      registerRoutes(app) { registerTagRoutes(app, { service: createTagService({}), verifyAuth }); },
    });
    const root = resolve('src') + '/';
    const forbidden = [...loaded].filter(p =>
      p.includes('/node_modules/pg/') ||
      p.startsWith(root) && (/\\/(?:tasks|ingest)\\//.test(p) || /\\/app\\/(?!Result\\.ts$)/.test(p))
    );
    if (forbidden.length) throw new Error(forbidden.join('\\n'));
  `;
  const child = spawnSync(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), '--import=tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
});
