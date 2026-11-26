import { Pool } from 'pg';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { startServer } from '../../src/hono.bootstrap.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const authorization = `Bearer ${jwt.sign({ id: '007' }, keys.privateKey, { algorithm: 'RS256' })}`;
const baseURL = 'https://api.example.test';

type Query = [sql: RegExp, params: unknown[] | undefined, result?: unknown[] | number | Error];
type ObservedResponse = { status: number | undefined; body: string; type?: string; length?: string; allow?: string };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coderx-task5c-comment-'));
  const environment = {
    CODERX_TEST_RESOURCE_ROOT: root,
    JWT_PRIVATE_KEY_PATH: join(root, 'private.pem'),
    JWT_PUBLIC_KEY_PATH: join(root, 'public.pem'),
    APP_ENV_FILE: join(root, '.env'),
    MEDIA_ROOT: join(root, 'media'),
    LOG_ROOT: join(root, 'logs'),
    APP_HOST: '127.0.0.1',
    APP_PORT: '0',
    PUBLIC_API_ORIGIN: baseURL,
    FRONTEND_URL: 'https://frontend.example.test',
    MEDIA_MUTATIONS_PAUSED: 'true',
    MEDIA_READ_MODE: 'local',
    BACKGROUND_JOBS_ENABLED: 'false',
    CONFIG_QUIET: 'true',
    SHUTDOWN_TIMEOUT_MS: '10000',
    DATABASE_URL: 'postgresql://test@postgres.example.invalid/test',
    NODE_ENV: 'production',
  };
  const isolatedPrefixes = /^(PG|REDIS_|R2_|AWS_|MEDIA_|GOOGLE_|GITHUB_|AI_|OLLAMA_)/;
  const names = new Set([...Object.keys(environment), ...Object.keys(process.env).filter(name => isolatedPrefixes.test(name))]);
  const previous = new Map(Array.from(names, name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, environment);
  const reads: Query[] = [];
  const transactions: Query[][] = [];
  const events: unknown[] = [];
  let queryError: unknown;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const poolEnd: (this: Pool) => Promise<void> = Pool.prototype.end;
  const poolEnded = new Promise<void>(resolve => {
    t.mock.method(Pool.prototype, 'end', async function (this: Pool) {
      try { await poolEnd.call(this); } finally { resolve(); }
    });
  });

  t.after(async () => {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
        await poolEnded;
      }
      if (queryError) throw queryError;
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  function query(queue: Query[], sql: string, params?: unknown[]) {
    let result: Query[2];
    try {
      const item = queue.shift();
      assert.ok(item, `unexpected SQL: ${sql}`);
      assert.match(sql.trim(), item[0]);
      assert.deepEqual(params, item[1]);
      result = item[2];
    } catch (error) {
      queryError = error;
      throw error;
    }
    if (result instanceof Error) throw result;
    const command = sql.trim().split(/\s+/, 1)[0];
    const rows = Array.isArray(result) ? result : [];
    return { command, rows, fields: [], rowCount: typeof result === 'number' ? result : rows.length };
  }

  t.mock.method(Pool.prototype, 'query', async (sql: string, params: unknown[]) => query(reads, sql, params));
  t.mock.method(Pool.prototype, 'connect', async () => {
    const queue = transactions.shift();
    assert.ok(queue, 'unexpected transaction');
    return {
      async query(sql: string, params?: unknown[]) {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) events.push(sql);
        return query(queue, sql, params);
      },
      release() {
        assert.deepEqual(queue, [], 'transaction ran every expected statement');
        events.push('release');
      },
    };
  });
  const createNotificationClient = () => ({
    isOpen: false,
    isReady: false,
    on() {},
    async connect() { this.isOpen = this.isReady = true; },
    async publish(channel: string, message: string) {
      events.push([channel, JSON.parse(message)]);
      return 1;
    },
    destroy() { this.isOpen = this.isReady = false; },
  });

  writeFileSync(environment.JWT_PRIVATE_KEY_PATH, keys.privateKey);
  writeFileSync(environment.JWT_PUBLIC_KEY_PATH, keys.publicKey);
  writeFileSync(environment.APP_ENV_FILE, '');
  server = await startServer({ createNotificationClient });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;

  function send(method: string, path: string, body?: object | string, auth = authorization): Promise<ObservedResponse> {
    return new Promise((resolve, reject) => {
      const payload = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { connection: 'close' };
      if (auth) headers.authorization = auth;
      if (payload !== undefined) {
        headers['content-type'] = typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      const req = request({
        host: '127.0.0.1', port, method, path, headers, signal: AbortSignal.timeout(2000),
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.once('error', reject);
        res.once('end', () => resolve({
          status: res.statusCode, body, type: res.headers['content-type'], length: res.headers['content-length'], allow: res.headers.allow,
        }));
      });
      req.once('error', reject);
      req.end(payload);
    });
  }

  return { send, reads, transactions, events };
}

const success = (data: unknown) => ({ data, code: 0 });
const failure = (msg: string, code = -1) => ({ msg, code });
const count = /^SELECT COUNT\(\*\) AS "totalCount" FROM comment WHERE article_id = \$1$/;
const byId = /WHERE c.id = \$1$/;
const statusQuery = /^SELECT status FROM "user" WHERE id = \$1;?$/i;
const permission = /^SELECT \* FROM comment WHERE id = \$1 AND user_id = \$2;$/;

function expectJson(response: ObservedResponse, status: number, value: unknown, head = false) {
  const body = JSON.stringify(value);
  assert.equal(response.status, status, response.body);
  assert.equal(response.type, 'application/json; charset=utf-8');
  assert.equal(response.length, String(Buffer.byteLength(body)));
  assert.equal(response.body, head ? '' : body);
}

test('comment public routes preserve literal priority, raw parameters, counts and HEAD headers', async t => {
  const { send, reads } = await fixture(t);
  const comment = { id: 4, articleId: 9, content: '<p>内容</p>', likes: '2' };
  reads.push(
    [count, ['9'], [{ totalCount: 12 }]],
    [byId, ['A%2FB'], [comment]],
    [count, [['9', '10']], [{ totalCount: '13' }]],
  );
  expectJson(await send('GET', '/CoMmEnT/CoUnT/?articleId=9', undefined, ''), 200, success({ totalCount: 12 }));
  expectJson(await send('GET', '/CoMmEnT/A%252FB/', undefined, ''), 200, success(comment));
  expectJson(await send('HEAD', '/comment/count?articleId=9&articleId=10', undefined, ''), 200, success({ totalCount: '13' }), true);
  expectJson(await send('GET', '/comment/count', undefined, ''), 200, failure('articleId is required'));
  expectJson(await send('GET', '/comment', undefined, ''), 200, failure('articleId is required'));
  assert.equal((await send('GET', '/comment/4/%72eplies')).status, 404);
  const options = await send('OPTIONS', '/comment/abc/');
  assert.equal(options.status, 200);
  assert.equal(options.allow, 'HEAD, GET, PUT, DELETE');
  assert.deepEqual(reads, []);
});

test('published media writers enter maintenance before auth while draft, tag and like writers remain available', async t => {
  const { send, reads, events } = await fixture(t);
  for (const [method, path] of [
    ['POST', '/article'], ['PUT', '/article/1'], ['DELETE', '/article/1'],
    ['POST', '/img'], ['POST', '/img/1'], ['DELETE', '/img'],
    ['POST', '/video'], ['POST', '/video/1'], ['DELETE', '/video'],
  ]) {
    expectJson(await send(method, path, undefined, ''), 503,
      failure('媒体上传和文章发布正在进行短时维护，请稍后重试', 503));
  }
  for (const [method, path] of [
    ['POST', '/article/1/like'], ['POST', '/article/1/tag'],
    ['PUT', '/draft'], ['GET', '/draft'], ['GET', '/draft/1'], ['DELETE', '/draft/1'],
  ]) {
    expectJson(await send(method, path, undefined, ''), 401, failure('未认证/token无效', 401));
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(events, []);
});

test('comment paging keeps legacy defaults, sort, moderation text and reply preview fallbacks', async t => {
  const { send, reads } = await fixture(t);
  const date = new Date('2026-11-17T03:04:05.000Z');
  const row = { id: 5, content: 'private', status: 1, createAt: date, likes: 3, replyCount: 2 };
  const reply = { id: 8, content: 'reply', createAt: date };
  reads.push(
    [/ORDER BY c.create_at DESC, c.id DESC\s+LIMIT \$2$/, ['9', '11'], []],
    [count, ['9'], [{ totalCount: 0 }]],
    [/ORDER BY c.create_at DESC, c.id DESC\s+LIMIT \$2$/, ['9', '6'], []],
    [count, ['9'], [{ totalCount: 0 }]],
    [/ORDER BY c.create_at DESC, c.id DESC\s+LIMIT \$2$/, ['9', '-1'], new Error('negative limit')],
    [/ORDER BY hot_comments.likes DESC[\s\S]+LIMIT \$2$/, ['9', '2'], [row, { id: 6 }]],
    [/WHERE c.comment_id = \$1\s+ORDER BY c.create_at ASC\s+LIMIT \$2$/, [5, '2'], new Error('preview unavailable')],
    [count, ['9'], [{ totalCount: 2 }]],
    [/WHERE c.comment_id = \$1[\s\S]+ORDER BY c.create_at ASC, c.id ASC\s+LIMIT \$2$/, ['5', '11'], []],
    [/SELECT COUNT\(\*\) AS "replyCount" FROM comment WHERE comment_id = \$1/, ['5'], [{ replyCount: '0' }]],
    [/WHERE c.comment_id = \$1[\s\S]+c.id > \$4[\s\S]+LIMIT \$5$/, ['5', '2026-11-17 03:04:05.000', '2026-11-17 03:04:05.000', '7', '4'], [reply]],
    [/SELECT COUNT\(\*\) AS "replyCount" FROM comment WHERE comment_id = \$1/, ['5'], [{ replyCount: '1' }]],
    [/WHERE c.user_id = \$1[\s\S]+LIMIT \$2 OFFSET \$3$/, ['7', '3', '2'], [
      { articleId: 9, status: 0, content: `<p>${'中'.repeat(55)}</p>`, author: { id: 7, avatarUrl: 'http://legacy.example/user/7/avatar' } },
      { articleId: 8, status: 1, content: 'private' },
    ]],
    [/SELECT COUNT\(\*\) AS total FROM comment WHERE user_id = \$1/, ['7'], [{ total: '4' }]],
  );
  expectJson(await send('GET', '/comment?articleId=9&sort=whichever'), 200, success({ items: [], nextCursor: null, hasMore: false, totalCount: 0 }));
  expectJson(await send('GET', '/comment?articleId=9&limit=0'), 200, success({ items: [], nextCursor: null, hasMore: false, totalCount: 0 }));
  expectJson(await send('GET', '/comment?articleId=9&limit=-2&sort=hot&sort=oldest'), 200, failure('获取评论列表失败'));
  expectJson(await send('GET', '/comment?articleId=9&sort=hot&pageSize=1'), 200, success({
    items: [{ ...row, content: '评论已被封禁', replies: [] }], nextCursor: '3_2_2026-11-17 03:04:05.000_5', hasMore: true, totalCount: 2,
  }));
  expectJson(await send('GET', '/comment/5/replies?cursor=&limit=-3'), 200, success({ items: [], nextCursor: null, hasMore: false, replyCount: '0' }));
  expectJson(await send('GET', `/comment/5/replies?cursor=${encodeURIComponent(`${date.toISOString()}_7`)}&limit=3`), 200,
    success({ items: [reply], nextCursor: null, hasMore: false, replyCount: '1' }));
  expectJson(await send('GET', '/comment?articleId=9&userId=7&pageNum=2&pageSize=2'), 200, success({
    items: [
      { articleId: 9, status: 0, content: '中'.repeat(50), author: { id: 7, avatarUrl: `${baseURL}/user/7/avatar` }, articleUrl: '/article/9' },
      { articleId: 8, status: 1, content: '评论已被封禁', articleUrl: '/article/8' },
    ], total: 4, hasMore: false, pageNum: 2, pageSize: 2,
  }));
  expectJson(await send('GET', '/comment?articleId=9&cursor=a&cursor=b'), 200, failure('获取评论列表失败'));
  expectJson(await send('GET', '/comment/5/replies?cursor=a&cursor=b'), 200, failure('获取回复列表失败'));
  assert.deepEqual(reads, []);
});

test('comment auth, bans and ownership run before writes and preserve failure bodies', async t => {
  const { send, reads, events } = await fixture(t);
  for (const [method, path] of [
    ['POST', '/comment'], ['POST', '/comment/4/reply'], ['POST', '/comment/4/like'], ['PUT', '/comment/4'], ['DELETE', '/comment/4'],
  ]) {
    expectJson(await send(method, path, undefined, ''), 401, failure('未认证/token无效', 401));
  }
  reads.push(
    [statusQuery, ['007'], [{ status: 1 }]],
    [statusQuery, ['007'], [{ status: '0' }]],
    [permission, ['4', '007'], []],
    [permission, ['4', '007'], new Error('permission lookup failed')],
    [statusQuery, ['007'], new Error('status lookup failed')],
    [statusQuery, ['007'], [{ status: 0 }]],
    [permission, ['4', '007'], [{ id: 4 }]],
  );
  expectJson(await send('POST', '/comment', { articleId: 9, content: 'blocked' }), 200, failure('您已被封禁'));
  expectJson(await send('POST', '/comment/4/reply', {}), 200, failure('您已被封禁'));
  expectJson(await send('PUT', '/comment/4'), 403, failure('不具备操作的权限', 403));
  expectJson(await send('DELETE', '/comment/4'), 403, failure('不具备操作的权限', 403));
  expectJson(await send('POST', '/comment', { articleId: 0, content: 'test' }), 200, failure('articleId and content are required'));
  expectJson(await send('POST', '/comment/4/reply', {}), 200, failure('articleId and content are required'));
  expectJson(await send('PUT', '/comment/4', { content: false }), 200, failure('content is required'));
  assert.deepEqual(reads, []);
  assert.deepEqual(events, []);
});

test('comment dependency errors map to each legacy response', async t => {
  const { send, reads } = await fixture(t);
  const unavailable = new Error('database unavailable');
  reads.push(
    [byId, ['4'], unavailable],
    [count, ['9'], unavailable],
    [/WHERE c.user_id = \$1/, ['7', '11', '0'], unavailable],
    [/WHERE c.comment_id = \$1/, ['4', '11'], unavailable],
    [permission, ['4', '007'], [{ id: 4 }]],
    [/^UPDATE comment SET content = \$1 WHERE id = \$2$/, ['edit', '4'], unavailable],
    [permission, ['4', '007'], [{ id: 4 }]],
    [byId, ['4'], [{ id: 4 }]],
    [byId, ['4'], [{ id: 4 }]],
    [/^DELETE FROM comment WHERE comment_id = \$1$/, ['4'], unavailable],
  );
  expectJson(await send('GET', '/comment/4'), 200, failure('评论不存在'));
  expectJson(await send('GET', '/comment/count?articleId=9'), 200, success({ totalCount: 0 }));
  expectJson(await send('GET', '/comment?userId=7'), 200, failure('获取用户评论列表失败'));
  expectJson(await send('GET', '/comment/4/replies'), 200, failure('获取回复列表失败'));
  expectJson(await send('PUT', '/comment/4', { content: 'edit' }), 200, failure('修改评论失败'));
  expectJson(await send('DELETE', '/comment/4'), 200, failure('删除评论失败'));
  assert.deepEqual(reads, []);
});

test('comment mutations retain raw body values and update/delete readback', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  const created = { id: 4, articleId: 9, content: ' ', likes: 0 };
  const updated = { ...created, content: 'edited' };
  reads.push(
    [statusQuery, ['007'], [{ status: 0 }]],
    [count, ['09'], [{ totalCount: 1 }]],
    [permission, ['4', '007'], [{ id: 4 }]],
    [/^UPDATE comment SET content = \$1 WHERE id = \$2$/, ['edited', '4'], 1],
    [byId, ['4'], [updated]],
    [permission, ['4', '007'], [{ id: 4 }]],
    [byId, ['4'], [updated]],
    [byId, ['4'], [updated]],
    [/^DELETE FROM comment WHERE comment_id = \$1$/, ['4'], 2],
    [/^DELETE FROM comment WHERE reply_id = \$1$/, ['4'], 0],
    [/^DELETE FROM comment WHERE id = \$1$/, ['4'], 1],
    [count, [9], [{ totalCount: 0 }]],
  );
  transactions.push([
    [/^BEGIN$/, undefined],
    [/^INSERT INTO comment \(user_id, article_id, content\)/, ['007', '09', ' '], [{ id: 4 }]],
    [/^SELECT user_id AS "authorId" FROM article/, ['09'], [{ authorId: '007' }]],
    [byId, [4], [created]],
    [/^COMMIT$/, undefined],
  ]);
  expectJson(await send('POST', '/comment', 'articleId=09&content=+&userId=999'), 200, success({ comment: created, totalCount: 1 }));
  expectJson(await send('PUT', '/comment/4', { content: 'edited' }), 200, success(updated));
  expectJson(await send('DELETE', '/comment/4'), 200, success({ deletedComment: updated, totalCount: 0 }));
  assert.deepEqual(reads, []);
  assert.deepEqual(transactions, []);
  assert.deepEqual(events, ['BEGIN', 'COMMIT', 'release']);
});

test('comment and reply notifications use the caller transaction and publish after release', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  const topLevel = { id: 4, articleId: 9, content: '<p>hello</p>', likes: 0 };
  const reply = { id: 8, articleId: 9, cid: 4, rid: null, content: '<p>reply</p>', likes: 0 };
  const commented = { id: 101, recipientId: 2, type: 'article_comment', commentId: 4 };
  const replied = { id: 102, recipientId: 2, type: 'comment_reply', commentId: '4' };
  reads.push(
    [statusQuery, ['007'], [{ status: 0 }]], [count, [9], [{ totalCount: 1 }]],
    [statusQuery, ['007'], [{ status: 0 }]], [count, [9], [{ totalCount: 2 }]],
    [statusQuery, ['007'], [{ status: 0 }]],
  );
  transactions.push([
    [/^BEGIN$/, undefined],
    [/^INSERT INTO comment \(user_id, article_id, content\)/, ['007', 9, topLevel.content], [{ id: 4 }]],
    [/FROM article WHERE id =/, [9], [{ authorId: 2 }]],
    [/^INSERT INTO notifications/, [2, '007', 'article_comment', 'article', 9, 9, 4, '{"commentExcerpt":"hello"}'], [{ id: 101 }]],
    [/WHERE n.id = \$1/, [101], [commented]],
    [byId, [4], [topLevel]],
    [/^COMMIT$/, undefined],
  ], [
    [/^BEGIN$/, undefined],
    [/^INSERT INTO comment \(user_id, article_id, comment_id, content\)/, ['007', 9, '4', reply.content], [{ id: 8 }]],
    [/FROM comment WHERE id =/, ['4'], [{ authorId: 2 }]],
    [/FROM article WHERE id =/, [9], [{ authorId: '2' }]],
    [/^INSERT INTO notifications/, [2, '007', 'comment_reply', 'article', 9, 9, '4', '{"commentExcerpt":"reply","replyId":8,"recipientRole":"comment_author"}'], [{ id: 102 }]],
    [/WHERE n.id = \$1/, [102], [replied]],
    [byId, [8], [reply]],
    [/^COMMIT$/, undefined],
  ], [
    [/^BEGIN$/, undefined],
    [/^INSERT INTO comment \(user_id, article_id, comment_id, reply_id, content\)/, ['007', 9, '4', 8, 'test'], [{ id: 9 }]],
    [/FROM comment WHERE id =/, [8], [{ authorId: 2 }]],
    [/FROM article WHERE id =/, [9], [{ authorId: 3 }]],
    [/^INSERT INTO notifications/, [2, '007', 'comment_reply', 'article', 9, 9, '4', '{"commentExcerpt":"test","replyId":9,"recipientRole":"comment_author"}'], [{ id: 103 }]],
    [/WHERE n.id = \$1/, [103], [{ id: 103 }]],
    [/^INSERT INTO notifications/, [3, '007', 'comment_reply', 'article', 9, 9, '4', '{"commentExcerpt":"test","replyId":9,"recipientRole":"article_author"}'], new Error('failed insert')],
    [/^ROLLBACK$/, undefined],
  ]);
  expectJson(await send('POST', '/comment', { articleId: 9, content: topLevel.content }), 200, success({ comment: topLevel, totalCount: 1 }));
  expectJson(await send('POST', '/comment/4/reply', { articleId: 9, replyId: 0, content: reply.content }), 200, success({ reply, totalCount: 2 }));
  expectJson(await send('POST', '/comment/4/reply', { articleId: 9, replyId: 8, content: 'test' }), 200, failure('回复评论失败'));
  assert.deepEqual(reads, []);
  assert.deepEqual(transactions, []);
  assert.deepEqual(events, [
    'BEGIN', 'COMMIT', 'release', ['coderx:notification:new', { event: 'notification:new', notification: commented }],
    'BEGIN', 'COMMIT', 'release', ['coderx:notification:new', { event: 'notification:new', notification: replied }],
    'BEGIN', 'ROLLBACK', 'release',
  ]);
});

test('comment like is auth-only and publishes on like without publishing on unlike or rollback', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  const notification = { id: 50, recipientId: 2, type: 'comment_like', commentId: '4' };
  reads.push([byId, ['4'], [{ likes: 3 }]], [byId, ['4'], new Error('read unavailable')]);
  transactions.push([
    [/^BEGIN$/, undefined],
    [/^DELETE FROM comment_like/, ['4', '007'], 0],
    [/FROM comment\s+WHERE id = \$1/, ['4'], [{ authorId: 2, articleId: 9, parentCommentId: 3, content: '<p>test</p>' }]],
    [/^INSERT INTO comment_like/, ['4', '007'], 1],
    [/pg_advisory_xact_lock/, ['comment_like:2:007:comment:4']],
    [/FROM notifications/, [2, '007', 'comment_like', 'comment', '4'], []],
    [/^INSERT INTO notifications/, [2, '007', 'comment_like', 'comment', '4', 9, '4', '{"commentExcerpt":"test","parentCommentId":3}'], [{ id: 50 }]],
    [/WHERE n.id = \$1/, [50], [notification]],
    [/^COMMIT$/, undefined],
  ], [
    [/^BEGIN$/, undefined],
    [/^DELETE FROM comment_like/, ['4', '007'], 1],
    [/^COMMIT$/, undefined],
  ], [
    [/^BEGIN$/, undefined],
    [/^DELETE FROM comment_like/, ['4', '007'], 0],
    [/FROM comment\s+WHERE id = \$1/, ['4'], []],
    [/^ROLLBACK$/, undefined],
  ]);
  expectJson(await send('POST', '/comment/4/like'), 200, success({ liked: true, likes: 3 }));
  expectJson(await send('POST', '/comment/4/like'), 200, success({ liked: false, likes: 0 }));
  expectJson(await send('POST', '/comment/4/like'), 200, failure('操作失败'));
  assert.deepEqual(reads, []);
  assert.deepEqual(transactions, []);
  assert.deepEqual(events, [
    'BEGIN', 'COMMIT', 'release', ['coderx:notification:new', { event: 'notification:new', notification }],
    'BEGIN', 'COMMIT', 'release',
    'BEGIN', 'ROLLBACK', 'release',
  ]);
});

test('comment and reply readback failures roll back without publishing', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  const readbackError = new Error('readback query failed');
  reads.push(
    [statusQuery, ['007'], [{ status: 0 }]],
    [statusQuery, ['007'], [{ status: 0 }]],
  );
  transactions.push([
    [/^BEGIN$/, undefined],
    [/^INSERT INTO comment \(user_id, article_id, content\)/, ['007', 9, 'first'], [{ id: 4 }]],
    [/FROM article WHERE id =/, [9], [{ authorId: 2 }]],
    [/^INSERT INTO notifications/, [2, '007', 'article_comment', 'article', 9, 9, 4, '{"commentExcerpt":"first"}'], [{ id: 101 }]],
    [/WHERE n.id = \$1/, [101], [{ id: 101 }]],
    [byId, [4], readbackError],
    [/^ROLLBACK$/, undefined],
  ], [
    [/^BEGIN$/, undefined],
    [/^INSERT INTO comment \(user_id, article_id, comment_id, content\)/, ['007', 9, '4', 'reply'], [{ id: 8 }]],
    [/FROM comment WHERE id =/, ['4'], [{ authorId: 2 }]],
    [/FROM article WHERE id =/, [9], [{ authorId: '2' }]],
    [/^INSERT INTO notifications/, [2, '007', 'comment_reply', 'article', 9, 9, '4', '{"commentExcerpt":"reply","replyId":8,"recipientRole":"comment_author"}'], [{ id: 102 }]],
    [/WHERE n.id = \$1/, [102], [{ id: 102 }]],
    [byId, [8], readbackError],
    [/^ROLLBACK$/, undefined],
  ]);
  expectJson(await send('POST', '/comment', { articleId: 9, content: 'first' }), 200, failure('发表评论失败'));
  expectJson(await send('POST', '/comment/4/reply', { articleId: 9, content: 'reply' }), 200, failure('回复评论失败'));
  assert.deepEqual(reads, []);
  assert.deepEqual(transactions, []);
  assert.deepEqual(events, ['BEGIN', 'ROLLBACK', 'release', 'BEGIN', 'ROLLBACK', 'release']);
});
