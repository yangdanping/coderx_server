import { Pool } from 'pg';
import { routers } from '../support/http-route-inventory.js';
import { frozenHttpContract } from '../support/frozen-http-contract.js';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import jwt from 'jsonwebtoken';
import { createHttpApp } from '../../src/http/app.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';
import { registerFlowRoutes } from '../../src/router/flow.router.js';
import { registerFlowDraftRoutes } from '../../src/router/flowDraft.router.js';
import BusinessError from '../../src/errors/BusinessError.js';
import { createPgClient } from '../../src/app/database/pg.factory.js';
import { createFlowService } from '../../src/service/flow.factory.js';
import type { FlowService, FlowDraftService } from '../../src/service/flow.types.js';
import { createDraftService } from '../../src/service/draft.factory.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const authorization = `Bearer ${jwt.sign({ id: '007' }, keys.privateKey, { algorithm: 'RS256' })}`;
const origin = 'https://api.example.test';
const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Flow fixture' }] }] };
const uuid = '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf';
const payload = { clientRequestId: uuid, content, mediaIds: [], draft: null };
const createdAt = new Date('2026-11-10T00:00:00Z');
const flowItem = {
  id: 42, author: { id: 7, name: 'Fixture', username: 'fixture', avatarUrl: '' },
  body: 'Flow fixture', bodyHtml: '<p>Flow fixture</p>', media: [], likes: 0, comments: 0, liked: false, createdAt,
};
const draftItem = {
  id: 9, userId: 7, draftType: 'flow' as const, articleId: null, title: null,
  content, meta: {}, version: 0, createAt: createdAt, updateAt: createdAt, images: [],
};

function trackServer(t: TestContext, server: { close(callback: (error?: Error) => void): unknown }) {
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
}

async function flowFixture(t: TestContext, responses?: 'flowRouting' | 'flowValidation') {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  let paused = false;
  let banned = false;
  function dependencies() {
    const calls: unknown[][] = [];
    const service: FlowService = {
      async createFlow(userId, input) { calls.push(['create', userId, input]); return flowItem; },
      async getFlowFeed(page, pageSize) { calls.push(['feed', page, pageSize]); return { items: [flowItem], total: 1, page, pageSize }; },
      async getFlowDetail(id) {
        calls.push(['detail', id]);
        if (id !== 42) throw new BusinessError('Flow 不存在', 404);
        return flowItem;
      },
    };
    const drafts: FlowDraftService = {
      async getFlowDraft(userId) { calls.push(['find draft', userId]); return null; },
      async upsertFlowDraft(userId, input) {
        calls.push(['save draft', userId, input]);
        return { ...draftItem, ...input };
      },
      async deleteFlowDraft(userId, id) { calls.push(['delete draft', userId, id]); return { id }; },
    };
    return {
      calls, service, drafts,
      async checkStatus(userId: unknown) { calls.push(['status', userId]); return banned ? 1 : 0; },
      async checkPermission() { throw new Error('Unexpected permission check'); },
    };
  }

  const current = dependencies();
  const auth = createAuthMiddleware({ ...current, publicKey: keys.publicKey });
  const candidate = createHttpApp({
    buildId: 'flow-test', checkReady: async () => false,
    registerRoutes(app) {
      registerFlowRoutes(app, { ...auth, service: current.service, maintenance: mediaMutationMaintenance(() => paused) });
      registerFlowDraftRoutes(app, { ...auth, service: current.drafts });
    },
  });
  const server = serve({ fetch: candidate.fetch, hostname: '127.0.0.1', port: 0 });
  trackServer(t, server);
  await once(server, 'listening');

  const contract = responses && frozenHttpContract(responses);
  if (contract) t.after(() => contract.assertComplete());

  async function compare(method: string, path: string, { body, authenticate = false, calls }: {
    body?: unknown; authenticate?: boolean; calls: unknown[][];
  }) {
    const actual = await rawRequest(server, method, path, body, authenticate);
    contract?.assert(method, path, actual);
    assert.deepEqual(current.calls.splice(0), calls, `candidate calls for ${method} ${path}`);
    return actual;
  }

  return {
    candidate, compare, pause(value: boolean) { paused = value; },
    ban() { banned = true; },
  };
}

function rawRequest(server: Pick<Server, 'address'>, method: string, path: string, json?: unknown, authenticate = false) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new Promise((resolve, reject) => {
    const body = json === undefined ? undefined : JSON.stringify(json);
    const headers: Record<string, string | number> = { connection: 'close' };
    if (authenticate) headers.authorization = authorization;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = request({ host: '127.0.0.1', port: address.port, method, path, headers, signal: AbortSignal.timeout(5000) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode, allow: response.headers.allow, vary: response.headers.vary,
        type: response.headers['content-type'], length: response.headers['content-length'],
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('Task 5D maps all six frozen Koa Flow and FlowDraft registrations', async t => {
  const { candidate } = await flowFixture(t);

  const frozen = [...routers['src/router/flow.router.js'], ...routers['src/router/flowDraft.router.js']];
  const strictKoa = /^\/flow\/([1-9]\d*)$/.toString();
  const strictHono = '/flow/:flowId{[1-9][0-9]*}';
  assert.equal(frozen.length, 6);
  assert.equal(frozen.filter(route => route.path === strictKoa).length, 1);
  const expected = frozen.flatMap(({ path, methods }) => methods.filter(method => method !== 'HEAD')
    .map(method => `${method} ${path === strictKoa ? strictHono : path}`));
  const actual = candidate.routes.filter(({ path }) => path === '/flow' || path.startsWith('/flow/'))
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual([...new Set(actual)].sort(), expected.sort());
});

test('Flow and FlowDraft match legacy raw paths, methods, HEAD and response headers', async t => {
  const { compare } = await flowFixture(t, 'flowRouting');
  await compare('GET', '/FlOw/', { calls: [['feed', 1, 10]] });
  await compare('HEAD', '/FLOW?pageNum=2&pageSize=3', { calls: [['feed', 2, 3]] });
  await compare('GET', '/flow/42?unused=ignored', { calls: [['detail', 42]] });
  await compare('HEAD', '/flow/42', { calls: [['detail', 42]] });
  await compare('GET', '/flow/999', { calls: [['detail', 999]] });
  await compare('GET', '/flow/9007199254740991', { calls: [['detail', Number.MAX_SAFE_INTEGER]] });
  await compare('GET', '/flow/9007199254740992', { calls: [] });
  for (const path of ['/FLOW/42', '/flow/42/', '/flow/042', '/flow/0', '/flow/-42', '/flow/a', '/flow/%34%32',
    '/%66low/42', '/flow/fixture/../42', '/flow/%2e/42', '/flow/42/../draft', '/flow/%64raft', '/%66low/']) {
    for (const method of ['GET', 'OPTIONS']) await compare(method, path, { calls: [] });
  }
  for (const method of ['POST', 'PATCH', 'OPTIONS', 'SEARCH']) {
    await compare(method, '/flow/42', { calls: [] });
  }
  await compare('OPTIONS', '/FlOw/', { calls: [] });
  await compare('GET', '/flow/draft', { calls: [] });
  await compare('HEAD', '/FlOw/DrAfT/', { authenticate: true, calls: [['find draft', '007']] });
  await compare('HEAD', '/FlOw/DrAfT/', { calls: [] });
  for (const method of ['POST', 'PATCH', 'OPTIONS', 'SEARCH']) {
    await compare(method, '/FlOw/DrAfT/', { calls: [] });
  }
  await compare('OPTIONS', '/FlOw/DrAfT/9', { calls: [] });
  await compare('DELETE', '/FlOw/DrAfT/%39/', { authenticate: true, calls: [['delete draft', '007', 9]] });
  for (const path of ['/flow/draft/%2539', '/flow/draft/%39%malformed', '/flow/draft/09', '/flow/draft/9007199254740992']) {
    await compare('DELETE', path, { authenticate: true, calls: [] });
  }
});

test('Flow controller matches legacy UUID, field validation order, pagination and gates', async t => {
  const { compare, pause, ban } = await flowFixture(t, 'flowValidation');
  await compare('POST', '/flow', { body: {}, calls: [] });
  pause(true);
  await compare('POST', '/flow', { body: {}, calls: [] });
  await compare('POST', '/flow', { body: payload, authenticate: true, calls: [] });
  await compare('GET', '/flow/draft', { authenticate: true, calls: [['find draft', '007']] });
  pause(false);
  const status = ['status', '007'];
  const accepted = [
    ...Array.from({ length: 8 }, (_, index) => `01234567-89ab-${index + 1}cde-8fab-0123456789ab`),
    '00000000-0000-0000-0000-000000000000', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
  ];
  for (const clientRequestId of accepted) {
    const body = { ...payload, clientRequestId };
    await compare('POST', '/FlOw/', { body, authenticate: true, calls: [status, ['create', '007', body]] });
  }
  const draft = { id: 9, version: 1 };
  await compare('POST', '/flow', {
    body: { ...payload, mediaIds: [2, 1], draft: { ...draft, extra: 'ignored' }, extra: 'ignored' }, authenticate: true,
    calls: [status, ['create', '007', { ...payload, mediaIds: [2, 1], draft }]],
  });
  for (const body of [
    {}, { ...payload, clientRequestId: '01234567-89ab-8cde-0fab-0123456789ab', content: [] },
    { ...payload, clientRequestId: '01234567-89ab-9cde-8fab-0123456789ab' },
    { ...payload, content: {}, mediaIds: null, draft: undefined },
    { ...payload, mediaIds: null, draft: undefined },
    { ...payload, mediaIds: Array(10).fill('1') },
    { ...payload, mediaIds: ['1'] }, { ...payload, mediaIds: [Number.MAX_SAFE_INTEGER + 1] },
    { ...payload, mediaIds: [1, 1], draft: undefined },
    { ...payload, draft: undefined }, { ...payload, draft: { id: '9', version: 1 } },
    { ...payload, draft: { id: 9, version: 0 } },
  ]) await compare('POST', '/flow', { body, authenticate: true, calls: [status] });

  for (const query of ['pageNum=1&pageNum=1', 'pageSize=10&pageSize=10', 'pageNum=', 'pageNum=01',
    'pageNum=0', 'pageSize=101', 'pageNum=9007199254740992', 'pageNum=%2B2', 'pageNum=2%20']) {
    await compare('GET', `/flow?${query}`, { calls: [] });
  }
  await compare('GET', '/flow?pageNum=%32&pageSize=100', { calls: [['feed', 2, 100]] });

  ban();
  await compare('POST', '/flow', { body: {}, authenticate: true, calls: [status] });
  await compare('PUT', '/flow/draft', { body: { content }, authenticate: true, calls: [['save draft', '007', { content, meta: {}, version: 0 }]] });
  await compare('PUT', '/flow/draft', { body: { content, meta: { title: null }, version: '2' }, authenticate: true,
    calls: [['save draft', '007', { content, meta: { title: null }, version: 2 }]],
  });
  for (const body of [{ content: [], meta: [] }, { content, meta: null, version: '01' },
    { content, version: '01' }, { content, version: null }, { content, version: Number.MAX_SAFE_INTEGER + 1 }]) {
    await compare('PUT', '/flow/draft', { body, authenticate: true, calls: [] });
  }
  await compare('PUT', '/flow/draft', { body: { content }, calls: [] });
  await compare('DELETE', '/flow/draft/9', { calls: [] });
});

type Step = [sql: RegExp, params: unknown[] | undefined, rows?: Record<string, unknown>[], rowCount?: number];

function transactionFixture(t: TestContext) {
  const reads: Step[] = [];
  const transactions: Step[][] = [];
  const events: unknown[] = [];
  function query(steps: Step[], sql: string, params?: unknown[]) {
    const step = steps.shift();
    assert.ok(step, `Unexpected SQL: ${sql}`);
    const [pattern, expected, rows = [], rowCount = rows.length] = step;
    assert.match(sql.trim().replace(/\s+/g, ' '), pattern);
    assert.deepEqual(params, expected);
    const [command] = sql.trim().split(/\s+/);
    events.push(command);
    return { command, rows, rowCount, fields: [] };
  }
  t.mock.method(Pool.prototype, 'query', async (sql: string, params?: unknown[]) => query(reads, sql, params));
  t.mock.method(Pool.prototype, 'connect', async () => {
    const steps = transactions.shift();
    assert.ok(steps, 'Unexpected transaction');
    return {
      async query(sql: string, params?: unknown[]) { return query(steps, sql, params); },
      release() { events.push('release'); assert.deepEqual(steps, []); },
    };
  });
  const database = createPgClient({ DATABASE_URL: 'postgresql://test@postgres.example.invalid/test' }, {
    debug() {}, info() {}, error() {},
  });
  t.after(async () => {
    await database.end();
    assert.deepEqual(reads, []);
    assert.deepEqual(transactions, []);
  });
  const mediaRuntime = {
    async resolveImageUrl(id: number, { variant = 'original' }: { variant?: 'original' | 'small' } = {}) {
      return variant === 'original' ? `${origin}/article/images/${id}.webp` : null;
    },
    async promotePublishedImages({ images }: { images: readonly unknown[] }) { events.push(['promote', images]); },
  };
  const auth = createAuthMiddleware({
    publicKey: keys.publicKey, async checkStatus() { return 0; }, async checkPermission() { throw new Error('Unexpected permission check'); },
  });
  const app = createHttpApp({
    buildId: 'flow-test', checkReady: async () => false,
    registerRoutes(app) {
      registerFlowRoutes(app, {
        ...auth, service: createFlowService({ database, mediaRuntime, logger: console, publicApiOrigin: origin }),
        maintenance: mediaMutationMaintenance(() => false),
      });
      registerFlowDraftRoutes(app, { ...auth, service: createDraftService({ connection: database, mediaRuntime, baseURL: origin }) });
    },
  });
  function send(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { reads, transactions, events, send };
}

async function expectJson(response: Response, status: number, body: unknown) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(body)));
}

test('Flow publishes once, replays before draft or media locks, and rolls back stale draft updates', async t => {
  const { reads, transactions, events, send } = transactionFixture(t);
  const images = [
    { id: 52, filename: 'image-52.webp', mimetype: 'image/webp' },
    { id: 51, filename: 'image-51.webp', mimetype: 'image/webp' },
  ];
  const detail = {
    id: '42', content, bodyText: 'Flow fixture', createAt: createdAt,
    author: { id: '7', name: 'fixture', nickname: 'Fixture', avatarUrl: '/user/7/avatar' },
    media: [{ id: 51, position: 1 }, { id: '52', position: 0, altText: 'first' }],
  };
  const media = [52, 51].map((id, index) => {
    const url = `${origin}/article/images/${id}.webp`;
    return { id, url, thumbnailUrl: url, title: index === 0 ? 'first' : '' };
  });
  const item = { ...flowItem, media, author: { ...flowItem.author, avatarUrl: `${origin}/user/7/avatar` } };
  const request = { ...payload, mediaIds: [52, 51], draft: { id: 9, version: 3 } };
  const insert = /^INSERT INTO flow_post .* ON CONFLICT \(user_id, client_request_id\) DO NOTHING RETURNING id;/;
  const contentJson = JSON.stringify(content);
  const lockDraft = /^SELECT id, version FROM draft WHERE id = \$1 AND user_id = \$2 AND draft_type = 'flow'.* FOR UPDATE;/;
  const detailQuery = /^SELECT fp.id, .* WHERE fp.id = \$1;/;
  transactions.push([
    [/^BEGIN$/, undefined],
    [insert, [7, uuid, contentJson, 'Flow fixture'], [{ id: 42 }]],
    [lockDraft, [9, 7], [{ id: '9', version: '3' }]],
    [/^SELECT f.id FROM file f WHERE f.user_id = \$1 .* FOR UPDATE OF f;/, [7, 52, 51], [{ id: 51 }, { id: 52 }]],
    [/INNER JOIN image_meta .* f.user_id = \$1 .* f.draft_id = \$2\).* f.file_type = 'image'.* NOT EXISTS/, [7, 9, 52, 51], images.slice().reverse()],
    [/^UPDATE file SET draft_id = NULL WHERE draft_id = \$1 /, [9, 52, 51], [], 2],
    [/^INSERT INTO flow_post_media .* VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\);/, [42, 52, 0, 42, 51, 1], [], 2],
    [/^UPDATE draft SET status = 'consumed'.* WHERE id = \$1 AND user_id = \$2 AND draft_type = 'flow'/, [9, 7, null], [{ id: 9 }]],
    [/^COMMIT$/, undefined],
  ]);
  reads.push([detailQuery, [42], [detail]]);
  await expectJson(await send('POST', '/flow', request), 200, { data: item, code: 0 });
  assert.deepEqual(events.splice(0), ['BEGIN', 'INSERT', 'SELECT', 'SELECT', 'SELECT', 'UPDATE', 'INSERT', 'UPDATE', 'COMMIT', 'release', ['promote', images], 'SELECT']);

  transactions.push([[/^BEGIN$/, undefined], [insert, [7, uuid, contentJson, 'Flow fixture']], [/^ROLLBACK$/, undefined]]);
  reads.push(
    [/^SELECT id FROM flow_post WHERE user_id = \$1 AND client_request_id = \$2 /, [7, uuid], [{ id: 42 }]],
    [/^SELECT f.id, f.filename, f.mimetype FROM flow_post_media .* WHERE fm.flow_id = \$1 /, [42], images],
    [detailQuery, [42], [detail]],
  );
  await expectJson(await send('POST', '/flow', request), 200, { data: item, code: 0 });
  assert.deepEqual(events.splice(0), ['BEGIN', 'INSERT', 'ROLLBACK', 'release', 'SELECT', 'SELECT', ['promote', images], 'SELECT']);

  const newUuid = '01234567-89ab-8cde-8fab-0123456789ab';
  transactions.push([
    [/^BEGIN$/, undefined], [insert, [7, newUuid, contentJson, 'Flow fixture'], [{ id: 43 }]],
    [lockDraft, [9, 7], [{ id: 9, version: 4 }]], [/^ROLLBACK$/, undefined],
  ]);
  await expectJson(await send('POST', '/flow', { ...request, clientRequestId: newUuid }), 409, {
    msg: 'Flow 草稿已发生变更，请重新打开编辑器后再发布', code: 409,
  });
  assert.deepEqual(events.splice(0), ['BEGIN', 'INSERT', 'SELECT', 'ROLLBACK', 'release']);
  await expectJson(await send('GET', '/flow?pageNum=9007199254740991&pageSize=100'), 400, {
    msg: '参数错误: 分页范围无效', code: 400,
  });
  await expectJson(await send('POST', '/flow', { ...payload, content: { type: 'doc', content: [] } }), 400, {
    msg: 'Flow 必须包含正文或图片', code: 400,
  });
  assert.deepEqual(events, []);
});

test('FlowDraft verifies owner and version before committing media bindings', async t => {
  const { reads, transactions, events, send } = transactionFixture(t);
  const upsert = /^INSERT INTO draft .* VALUES \('flow'.* ON CONFLICT \(user_id\) WHERE draft_type = 'flow' AND status = 'active' .* WHERE draft.version = \$6 /;
  const find = /^SELECT id, .* FROM draft WHERE user_id = \$1 AND draft_type = 'flow' AND article_id IS NULL AND status = 'active'/;
  const discard = /^UPDATE draft SET status = 'discarded'.* WHERE id = \$1 AND user_id = \$2 AND draft_type = 'flow'/;
  const clear = /^UPDATE file SET draft_id = NULL WHERE user_id = \$1 AND draft_id = \$2 /;
  const recoverImages = /^SELECT f.id, .* f.user_id = \$1 AND f.draft_id = \$2 .* f.file_type = 'image' AND NOT EXISTS/;
  const meta = { imageIds: [52] };
  const row = { ...draftItem, meta, version: 1 };
  const image = { id: 52, filename: 'fixture.webp', mimetype: 'image/webp', size: '10', width: '20', height: '15' };
  const result = { ...row, images: [{
    id: 52, url: `${origin}/article/images/52.webp`, thumbnailUrl: `${origin}/article/images/fixture.webp?type=small`,
    mimeType: 'image/webp', sizeBytes: 10, width: 20, height: 15,
  }] };
  const saveArgs = ['007', null, null, JSON.stringify(content), JSON.stringify(meta), 0];
  transactions.push([
    [/^BEGIN$/, undefined], [upsert, saveArgs, [{ id: 9 }]], [find, ['007'], [row]],
    [/^SELECT id FROM file WHERE user_id = \$1 AND draft_id = \$2 /, ['007', 9]],
    [/^SELECT id FROM file WHERE user_id = \$1 .* FOR UPDATE;/, ['007', [52]], [{ id: 52 }]],
    [/^SELECT id, article_id AS "articleId" FROM file WHERE user_id = \$1 .* AND NOT EXISTS/, ['007', [52], null, 9], [{ id: 52 }]],
    [clear, ['007', 9, [52]]],
    [/^UPDATE file SET draft_id = \$2 WHERE user_id = \$1 .* AND NOT EXISTS/, ['007', 9, [52], null], [], 1],
    [recoverImages, [7, 9, [52]], [image]], [/^COMMIT$/, undefined],
  ]);
  await expectJson(await send('PUT', '/flow/draft', { content, meta: { imageIds: ['52', 52] }, version: '0' }), 200, { data: result, code: 0 });
  assert.deepEqual(events.splice(0), ['BEGIN', 'INSERT', 'SELECT', 'SELECT', 'SELECT', 'SELECT', 'UPDATE', 'UPDATE', 'SELECT', 'COMMIT', 'release']);

  reads.push([find, ['007'], [row]], [recoverImages, [7, 9, [52]], [image]]);
  await expectJson(await send('GET', '/flow/draft'), 200, { data: result, code: 0 });
  assert.deepEqual(events.splice(0), ['SELECT', 'SELECT']);
  reads.push([find, ['007'], [row]], [recoverImages, [7, 9, [52]]]);
  await expectJson(await send('GET', '/flow/draft'), 409, { msg: 'Flow 草稿图片无法完整恢复', code: 409 });
  assert.deepEqual(events.splice(0), ['SELECT', 'SELECT']);

  transactions.push([[/^BEGIN$/, undefined], [upsert, saveArgs], [/^ROLLBACK$/, undefined]]);
  await expectJson(await send('PUT', '/flow/draft', { content, meta }), 409, { msg: '草稿版本冲突', code: 409 });
  assert.deepEqual(events.splice(0), ['BEGIN', 'INSERT', 'ROLLBACK', 'release']);

  transactions.push([[/^BEGIN$/, undefined], [discard, [10, '007']], [/^ROLLBACK$/, undefined]]);
  await expectJson(await send('DELETE', '/flow/draft/10'), 404, { msg: '草稿不存在', code: 404 });
  assert.deepEqual(events.splice(0), ['BEGIN', 'UPDATE', 'ROLLBACK', 'release']);

  transactions.push([[/^BEGIN$/, undefined], [discard, [9, '007'], [{ id: 9 }]], [clear, ['007', 9, []]], [/^COMMIT$/, undefined]]);
  await expectJson(await send('DELETE', '/flow/draft/9'), 200, { data: { id: 9 }, code: 0 });
  assert.deepEqual(events.splice(0), ['BEGIN', 'UPDATE', 'UPDATE', 'COMMIT', 'release']);
});
