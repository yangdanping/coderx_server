import { observeImports } from '../support/observe-imports.js';
import BusinessError from '../../src/errors/BusinessError.js';
import jsonwebtoken from 'jsonwebtoken';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHttpApp } from '../../src/http/app.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { createSocketAuthenticator } from '../../src/socket/auth/socketAuth.factory.js';
const jwt = jsonwebtoken as { sign(payload: unknown, key: KeyObject | string, options: Record<string, unknown>): string };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sign = (payload: unknown = { id: 7, name: 'alice', extra: { role: 'test' } }, options: Record<string, unknown> = {}) => jwt.sign(payload, keys.privateKey, { algorithm: 'RS256', ...options });
const socket = createSocketAuthenticator({ publicKey: keys.publicKey });
function fixture(options: { status?: (id: unknown) => Promise<unknown>; permission?: (table: string, id: string, user: unknown) => Promise<unknown>; failure?: Error } = {}) {
  const records: unknown[] = [];
  const auth = createAuthMiddleware({ publicKey: keys.publicKey, checkStatus: options.status ?? (async () => false), checkPermission: options.permission ?? (async () => true) });
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, logRequest: r => records.push(r), registerRoutes(app) {
    app.post('/resource/:commentId/:otherId', auth.verifyAuth, auth.verifyStatus, auth.verifyPermission, c => { if (options.failure) throw options.failure; return c.json(c.get('user')); });
  }});
  const request = (authorization?: string) => app.request('/resource/004/999?userId=forged', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: '{"id":"forged","userId":"forged"}' });
  return { request, records };
}

test('auth retains verified claims and uses only signed identity in service arguments', async () => {
  const args: unknown[][] = [];
  const { request } = fixture({ status: async id => { args.push([id]); return 0; }, permission: async (...values) => { args.push(values); return true; } });
  const token = sign(undefined, { expiresIn: '7d' });
  for (const header of [token, `Bearer ${token}`]) {
    const response = await request(header); assert.equal(response.status, 200);
    const payload = await response.json(); assert.equal(payload.id, 7); assert.equal(payload.name, 'alice'); assert.deepEqual(payload.extra, { role: 'test' }); assert.equal(payload.exp - payload.iat, 604800);
    assert.deepEqual(socket({ auth: { token: header }, query: { userId: 'forged', userName: 'forged' } }), { mode: 'user', userId: '7', userName: 'alice' });
  }
  assert.deepEqual(args, [[7], ['comment', '004', 7], [7], ['comment', '004', 7]]);
});

test('HTTP and Socket enforce shared crypto validity without requiring expiry', async () => {
  const { request } = fixture();
  const invalid = ['garbage', sign(undefined, { expiresIn: -1 }), sign(undefined, { notBefore: '1h' }), jwt.sign({ id: 7, name: 'alice' }, other.privateKey, { algorithm: 'RS256' }), jwt.sign({ id: 7, name: 'alice' }, 'secret', { algorithm: 'HS256' })];
  for (const token of invalid) {
    const res = await request(`Bearer ${token}`); assert.equal(res.status, 401); assert.deepEqual(await res.json(), { msg: '未认证/token无效', code: 401 });
    assert.throws(() => socket({ auth: { token } }), /authentication failed/);
  }
  const missing = await request(); assert.equal(missing.status, 401);
  for (const token of [sign(), sign(undefined, { notBefore: -1 })]) { assert.equal((await request(token)).status, 200); assert.equal(socket({ auth: { token } }).mode, 'user'); }
});

test('HTTP accepts arbitrary signed strings and id-less objects; Socket keeps identity requirements', async () => {
  for (const payload of ['hello', { custom: ['value'] }]) {
    const seen: unknown[] = [];
    const { request } = fixture({ status: async id => { seen.push(id); return false; } });
    const token = sign(payload, typeof payload === 'string' ? {} : { noTimestamp: true });
    const response = await request(token); assert.equal(response.status, 200); assert.deepEqual(await response.json(), payload); assert.deepEqual(seen, [undefined]);
    assert.throws(() => socket({ auth: { token } }), /authentication failed/);
  }
  const payload = { id: '007', name: 123, iat: 1, extension: true };
  assert.deepEqual(await (await fixture().request(sign(payload))).json(), payload);
  assert.deepEqual(socket({ auth: { token: sign(payload) } }), { mode: 'user', userId: '007', userName: '123' });
});

test('HTTP preserves signed JSON array payloads accepted by jsonwebtoken', async () => {
  const token = sign('["legacy",7]');
  const response = await fixture().request(token);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ['legacy', 7]);
  assert.throws(() => socket({ auth: { token } }), /authentication failed/);
});

test('HTTP preserves signed numeric and boolean payloads decoded with a JWT type header', async () => {
  for (const payload of [7, 0, true, false]) {
    const seen: unknown[] = [];
    const token = sign(JSON.stringify(payload), { header: { typ: 'JWT' } });
    const response = await fixture({ status: async id => { seen.push(id); return false; } }).request(token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.deepEqual(seen, [undefined]);
    assert.throws(() => socket({ auth: { token } }), /authentication failed/);
  }
});

test('status truthiness returns legacy ban envelope; status service failures stay 500', async () => {
  for (const status of [true, 1, 'banned', {}]) {
    const res = await fixture({ status: async () => status }).request(sign()); assert.equal(res.status, 200); assert.deepEqual(await res.json(), { msg: '您已被封禁', code: -1 });
  }
  const res = await fixture({ status: async () => { throw new Error('service secret'); } }).request(sign()); assert.equal(res.status, 500); assert.deepEqual(await res.json(), { msg: '服务器内部错误', code: 500 });
});

test('denied, missing, and rejected permission responses keep 403', async () => {
  for (const permission of [async () => false, async () => undefined, async () => { throw new Error('service secret'); }]) {
    const res = await fixture({ permission }).request(sign()); assert.equal(res.status, 403); assert.deepEqual(await res.json(), { msg: '不具备操作的权限', code: 403 });
  }
});

test('downstream errors escape auth and permission boundaries and logs contain final status only', async () => {
  for (const [failure, status, msg] of [[new BusinessError('业务错误', 400), 400, '业务错误'], [new Error('secret'), 500, '服务器内部错误']] as const) {
    const { request, records } = fixture({ failure }); const res = await request(sign()); assert.equal(res.status, status); assert.deepEqual(await res.json(), { msg, code: status });
    assert.equal((records[0] as { status: number }).status, status); assert.deepEqual(Object.keys(records[0] as object).sort(), ['durationMs', 'method', 'status']); assert.doesNotMatch(JSON.stringify(records), /secret|alice|forged|Bearer/);
  }
});

test('Socket preserves guests, source priority, array handling, claims and extra trimming', async () => {
  assert.deepEqual(socket(), { mode: 'guest' }); assert.deepEqual(socket({ query: { userId: ' ', userName: [''] } }), { mode: 'guest' });
  for (const query of [{ userId: '7' }, { userName: ['alice'] }]) assert.throws(() => socket({ query }), /authentication required/);
  const good = sign(), second = sign({ id: 8, name: 'bob' });
  assert.deepEqual(socket({ auth: { token: [good, 'bad'], authorization: second }, headers: { authorization: second } }), { mode: 'user', userId: '7', userName: 'alice' });
  assert.deepEqual(socket({ auth: { token: ' ', authorization: second }, headers: { authorization: good } }), { mode: 'user', userId: '8', userName: 'bob' });
  assert.deepEqual(socket({ headers: { authorization: good } }), { mode: 'user', userId: '7', userName: 'alice' });
  assert.throws(() => socket({ auth: { token: 'bad', authorization: good } }), /failed/);
  assert.equal(socket({ auth: { token: `  Bearer   ${good}  ` } }).mode, 'user');
  assert.equal((await fixture().request(`Bearer   ${good}`)).status, 401);
});

test('auth, AI and Socket factory imports do not load config, services or logger', () => {
  const script = `
    ${observeImports}
    await import('./src/middleware/auth.middleware.js');
    await import('./src/middleware/ai.middleware.js');
    await import('./src/socket/auth/socketAuth.factory.js');
    const forbidden = [...loaded].filter(path => path.startsWith(resolve('src') + '/') &&
      ['app', 'service', 'logger'].some(part => path.startsWith(resolve('src', part) + '/')));
    if (forbidden.length) throw new Error(forbidden.join(', '));
  `;
  const child = spawnSync(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), '--import=tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});
