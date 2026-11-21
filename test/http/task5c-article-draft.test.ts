import { routers } from '../support/http-route-inventory.js';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { createHttpApp } from '../../src/http/app.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';
import { registerArticleRoutes } from '../../src/router/article.router.js';
import { registerCommentRoutes } from '../../src/router/comment.router.js';
import { registerDraftRoutes } from '../../src/router/draft.router.js';
import { createArticleService } from '../../src/service/article.factory.js';
import { createArticleLikeService } from '../../src/service/articleLike.factory.js';
import type { ArticleTransaction } from '../../src/service/article/article.types.js';
import { createAuthService } from '../../src/service/auth/auth.service.js';
import { createCommentService } from '../../src/service/comment.factory.js';
import { createCommentLikeService } from '../../src/service/commentLike.factory.js';
import { createDraftService } from '../../src/service/draft.factory.js';
import { createFileService } from '../../src/service/file.factory.js';
import { createHistoryService } from '../../src/service/history/history.service.js';
import { LocalMediaCleanupService, buildLocalCleanupEntries } from '../../src/service/localMediaCleanup.service.js';
import { createMediaRuntime } from '../../src/service/mediaRuntime.factory.js';
import { createNotificationService } from '../../src/service/notification.factory.js';
import { createTagService } from '../../src/service/tag/tag.service.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const authorization = `Bearer ${jwt.sign({ id: 7 }, keys.privateKey, { algorithm: 'RS256' })}`;
const origin = 'https://api.example.test';
const frontend = 'https://app.example.test';
const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fixture' }] }] };
const mutation = (command: 'INSERT' | 'UPDATE' | 'DELETE', insertId = 0, affectedRows = 1) =>
  ({ affectedRows, changedRows: affectedRows, insertId, rowCount: affectedRows, command });

type Query = [pattern: RegExp, params: unknown[], result: unknown];

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'task5c-article-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageRoot = join(root, 'img');
  const videoRoot = join(root, 'video');
  await mkdir(imageRoot);
  await mkdir(videoRoot);

  const reads: Query[] = [];
  const transactions: Query[][] = [];
  const events: unknown[] = [];
  let paused = false;
  async function execute(replies: Query[], sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    const query = replies.shift();
    if (!query) throw new Error(`Unexpected SQL: ${sql}`);
    assert.match(sql.trim(), query[0]);
    assert.deepEqual(params, query[1]);
    if (query[2] instanceof Error) throw query[2];
    return [query[2], []];
  }
  const database = {
    execute: (sql: string, params?: unknown[]) => execute(reads, sql, params),
    async getConnection(): Promise<ArticleTransaction> {
      const queries = transactions.shift();
      if (!queries) throw new Error('Unexpected transaction');
      events.push('connection');
      return {
        execute: (sql, params) => execute(queries, sql, params),
        async beginTransaction() { events.push('begin'); },
        async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },
        release() {
          events.push('release');
          assert.deepEqual(queries, []);
        },
      };
    },
    async end() {},
  };
  const mediaRuntime = createMediaRuntime({
    database, imageRoot, videoRoot, publicApiOrigin: origin, readMode: 'local', writeMode: 'local',
    writePaused: false, bucket: 'fixture', cdnBaseUrl: 'https://cdn.example.test', hardLimitBytes: 1024,
    accountId: '', accessKeyId: '', secretAccessKey: '',
  });
  t.after(() => {
    mediaRuntime.close();
    assert.deepEqual(reads, []);
    assert.deepEqual(transactions, []);
  });
  const auth = createAuthMiddleware({ ...createAuthService(database), publicKey: keys.publicKey });
  const notificationService = createNotificationService(database, origin);
  const interactions = {
    connection: database, baseURL: origin, notificationService,
    async publishNotificationCreated(notification: unknown) { events.push(notification); },
  };
  const commentService = createCommentService(interactions);
  const cleanup = new LocalMediaCleanupService({ database, roots: { image: imageRoot, video: videoRoot } });
  const candidate = createHttpApp({
    buildId: 'task5c',
    checkReady: async () => false,
    registerRoutes(app) {
      registerCommentRoutes(app, {
        ...auth, service: commentService, likeService: createCommentLikeService(interactions),
      });
      registerDraftRoutes(app, { ...auth, service: createDraftService({ ...interactions, mediaRuntime }) });
      registerArticleRoutes(app, {
        ...auth,
        service: createArticleService({
          ...interactions, redirectURL: frontend, mediaRuntime,
          localMediaCleanup: {
            buildLocalCleanupEntries,
            enqueueInTransaction: (conn, entries) => cleanup.enqueueInTransaction(conn, entries),
            processPending: options => cleanup.processPending(options),
          },
        }),
        likeService: createArticleLikeService(interactions),
        historyService: createHistoryService(database, origin, frontend),
        tagService: createTagService(database),
        fileService: createFileService({ connection: database }),
        maintenance: mediaMutationMaintenance(() => paused),
        imageRoot, videoRoot,
      });
    },
  });
  function send(method: string, path: string, body?: unknown, authenticated = true) {
    const headers = new Headers();
    if (authenticated) headers.set('Authorization', authorization);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return candidate.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return { candidate, commentService, reads, transactions, events, send, imageRoot, videoRoot, pause: () => { paused = true; } };
}

async function json(response: Response, expected: unknown, status = 200, head = false) {
  const expectedBody = JSON.stringify(expected);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(expectedBody)));
  assert.equal(await response.text(), head ? '' : expectedBody);
}

test('Task 5C registers exactly the 27 article, draft and comment routes in the legacy inventory', async t => {
  const { candidate } = await fixture(t);

  for (const [group, count] of [['article', 14], ['draft', 4], ['comment', 9]] as const) {
    const entries = routers[`src/router/${group}.router.js`];
    assert.equal(entries.length, count);
    const expected = entries.flatMap(({ path, methods }) => methods.filter(method => method !== 'HEAD').map(method => `${method} ${path}`));
    const actual = candidate.routes.filter(({ path }) => path === `/${group}` || path.startsWith(`/${group}/`)).map(({ method, path }) => `${method} ${path}`);
    assert.deepEqual([...new Set(actual)].sort(), expected.sort());
  }
});

test('comment listing retains the explicit failure for a missing user page', async t => {
  const { commentService, send } = await fixture(t);
  const dependency: { getUserCommentList(userId: unknown, offset: string, limit: string): Promise<unknown> } = commentService;
  const getUserCommentList = t.mock.method(dependency, 'getUserCommentList', async () => null);
  await json(await send('GET', '/comment?userId=7', undefined, false), { msg: '获取用户评论列表失败!', code: -1 });
  assert.deepEqual(getUserCommentList.mock.calls.map(call => call.arguments), [['7', '0', '10']]);
});

test('article lists, static endpoints and detail retain query coercion and banned-field masking', async t => {
  const { send, reads } = await fixture(t);
  const long = 'x'.repeat(51);
  reads.push(
    [/ORDER BY a.create_at DESC/, [81, '10', '0'], [
      { id: 81, status: 0, excerpt: long, content: 'gone' },
      { id: 82, status: 1, title: 'gone', excerpt: 'gone', content: 'gone' },
    ]],
    [/COUNT\(DISTINCT a.id\)/, [81], [{ total: '2' }]],
    [/ORDER BY a.views DESC/, ['3', '6'], [{ id: 83, views: 4 }]],
    [/title ILIKE/, ['%x,y%', 10, 0], [{ id: 81 }]],
    [/ORDER BY random\(\)/, [], [{ id: 84 }]],
    [/a.content AS "contentJson"/, ['001'], [{ id: 1, title: 'gone', status: 1, contentJson: null, images: null, videos: null }]],
    [/a.content AS "contentJson"/, ['search'], new Error('invalid input syntax for type bigint')],
    [/a.content AS "contentJson"/, ['2'], []],
    [/COUNT\(al.user_id\) likes/, ['01'], [{ likes: '0' }]],
  );
  await json(await send('GET', '/ArTiClE/?offset=1&offset=2&pageOrder=hot&pageOrder=date&idList=%5B81%5D'), {
    data: { result: [{ id: 81, status: 0, excerpt: long.slice(0, 50), cover: null },
      { id: 82, status: 1, title: '文章已被封禁', excerpt: '文章已被封禁', cover: null }], total: '2' },
    code: 0,
  });
  await json(await send('GET', '/article?idList=%5B1%5D&idList='), { msg: '服务器内部错误', code: 500 }, 500);
  await json(await send('GET', '/ARTICLE/RECOMMEND/?pageNum=3&pageSize=3'), { data: [{ id: 83, views: 4 }], code: 0 });
  await json(await send('GET', '/article/search?keywords=x&keywords=y'), { data: [{ id: 81 }], code: 0 });
  await json(await send('HEAD', '/ARTICLE/RANDOM/TOC'), { data: { id: 84 }, code: 0 }, 200, true);
  await json(await send('GET', '/article/001'), {
    data: { id: 1, title: '文章已被封禁', status: 1, contentJson: null, images: [], videos: [],
      contentHtml: '文章已被封禁', excerpt: '文章已被封禁', content: '文章已被封禁' }, code: 0,
  });
  await json(await send('GET', '/article/%73earch'), { msg: '服务器内部错误', code: 500 }, 500);
  await json(await send('GET', '/article/2'), { msg: '文章不存在', code: 404 }, 404);
  await json(await send('GET', '/article/01/like'), { data: { likes: '0' }, code: 0 });
});

test('article image and video route bodies and headers follow the legacy local file contract', async t => {
  const { candidate, reads, imageRoot, videoRoot } = await fixture(t);
  await writeFile(join(imageRoot, 'Photo.png'), 'original');
  await writeFile(join(imageRoot, 'Photo-small.png'), 'thumbnail');
  await writeFile(join(videoRoot, 'Clip.MP4'), '0123456789');
  await mkdir(join(videoRoot, 'directory.mp4'));
  await symlink(join(imageRoot, 'Photo.png'), join(videoRoot, 'symlink.mp4'));
  for (const [query, expected] of [['?type=small', 'thumbnail'], ['?type=small&type=small', 'original']] as const) {
    reads.push([/^SELECT \* FROM file WHERE filename LIKE/, ['Photo.png%'], [{ mimetype: 'image/png' }]]);
    const response = await candidate.request(`/ARTICLE/IMAGES/Photo.png/${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), expected);
  }
  reads.push([/^SELECT \* FROM file WHERE filename LIKE/, ['absent.png%'], []]);
  const missingImage = await candidate.request('/article/images/absent.png');
  assert.equal(missingImage.status, 404);
  assert.equal(missingImage.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(missingImage.headers.get('content-length'), '9');
  assert.equal(await missingImage.text(), 'Not Found');
  reads.push([/^SELECT \* FROM file WHERE filename LIKE/, ['absent.png%'], []]);
  const missingHead = await candidate.request('/article/images/absent.png', { method: 'HEAD' });
  assert.equal(missingHead.status, 404);
  assert.equal(missingHead.headers.get('content-type'), null);
  assert.equal(missingHead.headers.get('content-length'), null);
  assert.equal(await missingHead.text(), '');

  // Reject decoded path separators before consulting file metadata.
  const traversal = await candidate.request('/article/images/..%2Fvideo%2FClip.MP4');
  assert.equal(traversal.status, 404);
  assert.equal(await traversal.text(), 'Not Found');

  await symlink(join(videoRoot, 'Clip.MP4'), join(imageRoot, 'linked.png'));
  for (const filename of ['stale.png', 'linked.png']) {
    for (const method of ['GET', 'HEAD']) {
      reads.push([/^SELECT \* FROM file WHERE filename LIKE/, [filename + '%'], [{ mimetype: 'image/png' }]]);
      const missing = await candidate.request(`/article/images/${filename}`, { method });
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), method === 'HEAD' ? '' : 'Not Found');
    }
  }

  const full = await candidate.request('/article/video/Clip.MP4');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(full.headers.get('accept-ranges'), null);
  assert.equal(full.headers.get('cache-control'), null);
  assert.equal(await full.text(), '0123456789');
  const range = await candidate.request('/article/video/Clip.MP4', { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(range.headers.get('accept-ranges'), 'bytes');
  assert.equal(range.headers.get('content-length'), '4');
  assert.equal(await range.text(), '2345');
  const suffix = await candidate.request('/article/video/Clip.MP4', { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.headers.get('content-range'), 'bytes */10');
  assert.equal(suffix.headers.get('accept-ranges'), null);
  await json(suffix, { msg: 'Range 请求无效', code: -1 }, 416);
  const rangeHead = await candidate.request('/article/video/Clip.MP4', { method: 'HEAD', headers: { Range: 'bytes=3-' } });
  assert.equal(rangeHead.status, 206);
  assert.equal(rangeHead.headers.get('content-type'), 'video/mp4');
  assert.equal(rangeHead.headers.get('content-range'), 'bytes 3-9/10');
  assert.equal(rangeHead.headers.get('content-length'), '7');
  assert.equal(await rangeHead.text(), '');
  for (const filename of ['missing.mp4', 'directory.mp4', 'symlink.mp4', '..%2Fimg%2FPhoto.png']) {
    await json(await candidate.request(`/article/video/${filename}`), { msg: '视频文件不存在', code: -1 }, 404);
  }
});

test('draft input, ownership, optimistic update and file binding preserve their transaction boundaries', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  await json(await send('GET', '/draft', undefined, false), { msg: '未认证/token无效', code: 401 }, 401);
  await json(await send('GET', '/draft/01'), { msg: '参数错误: articleId 必须是正整数', code: -1 });
  await json(await send('DELETE', '/draft/1e1'), { msg: '参数错误: draftId 必须是正整数', code: -1 });
  await json(await send('PUT', '/draft', { content: [], version: '00' }), { msg: '参数错误: content 必须是对象', code: -1 });
  await json(await send('PUT', '/draft', { content, meta: null }), { msg: '参数错误: meta 必须是对象', code: -1 });
  await json(await send('PUT', '/draft', { content, version: '00' }), { msg: '参数错误: version 必须是非负整数', code: -1 });
  await json(await send('PUT', '/draft', { content, articleId: '' }), { msg: '参数错误: articleId 必须是正整数', code: -1 });

  reads.push(
    [/FROM draft[\s\S]*article_id IS NULL/, [7], []],
    [/FROM article/, [12, 7], []],
    [/FROM article/, [13, 7], [{ id: 13 }]],
    [/FROM draft/, [7, 13], [{ id: 93, articleId: 13, content, version: 2 }]],
  );
  await json(await send('GET', '/DRAFT/'), { data: null, code: 0 });
  await json(await send('GET', '/draft/12'), { msg: '文章不存在或无权限', code: 404 }, 404);
  await json(await send('GET', '/draft/13'), { data: { id: 93, articleId: 13, content, version: 2 }, code: 0 });

  const upsert = /INSERT INTO draft[\s\S]*WHERE draft.version = \$6/;
  const metadata = { imageIds: [31] };
  const row = { id: 94, articleId: null, title: null, content, meta: metadata, version: 1 };
  const params = [7, null, null, JSON.stringify(content), JSON.stringify(metadata), 0];
  const upsertSteps: Query[] = [
    [upsert, params, mutation('INSERT', 94)],
    [/FROM draft/, [7], [row]],
    [/FROM file[\s\S]*draft_id = \$2/, [7, 94], []],
    [/FOR UPDATE/, [7, [31]], [{ id: 31 }]],
    [/SELECT[\s\S]*NOT EXISTS/, [7, [31], null, 94], [{ id: 31 }]],
    [/UPDATE file SET draft_id = NULL/, [7, 94, [31]], mutation('UPDATE')],
    [/UPDATE file SET draft_id = \$2/, [7, 94, [31], null], mutation('UPDATE')],
  ];
  transactions.push(upsertSteps, [[upsert, params, mutation('INSERT', 0, 0)]],
    [
      [upsert, params, mutation('INSERT', 94)], [/FROM draft/, [7], [row]],
      [/FROM file[\s\S]*draft_id = \$2/, [7, 94], []], [/FOR UPDATE/, [7, [31]], []],
    ],
    [
      [/status = 'discarded'/, [94, 7], mutation('UPDATE', 94)],
      [/UPDATE file SET draft_id = NULL/, [7, 94, []], mutation('UPDATE')],
    ],
    [[/status = 'discarded'/, [95, 7], mutation('UPDATE', 0, 0)]],
  );
  const body = { content, meta: { imageIds: ['31', '31', false] }, version: '0' };
  await json(await send('PUT', '/draft', body), { data: row, code: 0 });
  await json(await send('PUT', '/draft', body), { msg: '草稿版本冲突', code: 409 }, 409);
  await json(await send('PUT', '/draft', body), { msg: '草稿引用了无效文件', code: 400 }, 400);
  await json(await send('DELETE', '/draft/94'), { data: { id: 94 }, code: 0 });
  await json(await send('DELETE', '/draft/95'), { msg: '草稿不存在', code: 404 }, 404);
  assert.deepEqual(events, ['commit', 'rollback', 'rollback', 'commit', 'rollback'].flatMap(event => ['connection', 'begin', event, 'release']));
});

test('article mutation gates run before writes and tag resolution keeps legacy ordering and codes', async t => {
  const { send, reads, events, pause } = await fixture(t);
  await json(await send('POST', '/article', { contentJson: content }, false), { msg: '未认证/token无效', code: 401 }, 401);
  reads.push([/^SELECT status FROM/, [7], [{ status: 1 }]], [/^SELECT status FROM/, [7], [{ status: '0' }]]);
  await json(await send('POST', '/article', { contentJson: content }), { msg: '您已被封禁', code: -1 });
  await json(await send('POST', '/article/1/like'), { msg: '您已被封禁', code: -1 });
  reads.push([/^SELECT status FROM/, [7], [{ status: 0 }]]);
  await json(await send('POST', '/article', { draftId: '01', contentJson: null }), { msg: '参数错误: draftId 必须是正整数', code: -1 });
  for (const [method, path] of [['PUT', '/article/1'], ['DELETE', '/article/1'], ['POST', '/article/1/tag']] as const) {
    reads.push([/^SELECT \* FROM article/, ['1', 7], []]);
    await json(await send(method, path), { msg: '不具备操作的权限', code: 403 }, 403);
  }
  pause();
  for (const [method, path] of [['POST', '/article'], ['PUT', '/article/1'], ['DELETE', '/article/1']] as const) {
    await json(await send(method, path, undefined, false), { msg: '媒体上传和文章发布正在进行短时维护，请稍后重试', code: 503 }, 503);
  }
  assert.deepEqual(events, []);

  reads.push(
    [/^SELECT \* FROM article/, ['1', 7], [{ id: 1 }]],
    [/^SELECT \* FROM tag/, ['a'], [{ id: 2, name: 'a' }]],
    [/^SELECT \* FROM tag/, ['b'], []],
    [/^INSERT INTO tag/, ['b'], mutation('INSERT', 3)],
    [/^DELETE FROM article_tag/, ['1'], mutation('DELETE')],
    [/^INSERT INTO article_tag/, ['1', 2, '1', 3], mutation('INSERT', 0, 2)],
    [/^SELECT \* FROM article/, ['1', 7], [{ id: 1 }]],
    [/^DELETE FROM article_tag/, ['1'], mutation('DELETE')],
    [/^UPDATE article SET views/, ['01'], mutation('UPDATE')],
  );
  await json(await send('POST', '/article/1/tag', { tags: 'ab' }), { data: mutation('INSERT', 0, 2), code: '标签保存成功' });
  await json(await send('POST', '/article/1/tag', { tags: [] }), { data: '标签已清空', code: 0 });
  await json(await send('PUT', '/article/01/view', undefined, false), { data: mutation('UPDATE'), code: 0 });
});

test('article publish and update consume owned drafts atomically and keep structured-content errors', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  reads.push(
    [/^SELECT status FROM/, [7], [{ status: 0 }]],
    [/^SELECT status FROM/, [7], [{ status: 0 }]],
    [/^SELECT \* FROM article/, ['12', 7], [{ id: 12 }]],
    [/^SELECT \* FROM article/, ['12', 7], [{ id: 12 }]],
  );
  transactions.push(
    [
      [/FROM draft[\s\S]*article_id IS NULL FOR UPDATE/, [41, 7], [{ id: 41, title: 'draft', content }]],
      [/^INSERT INTO article/, [7, 'new', JSON.stringify(content), 'fixture'], mutation('INSERT', 12)],
      [/status = 'consumed'/, [41, 7, 12], mutation('UPDATE')],
    ],
    [],
    [
      [/FROM draft[\s\S]*article_id = \$3 FOR UPDATE/, [42, 7, '12'], [{ id: 42, content }]],
      [/^UPDATE article SET title/, ['edit', JSON.stringify(content), 'fixture', '12'], mutation('UPDATE')],
      [/status = 'consumed'/, [42, 7, '12'], mutation('UPDATE')],
    ],
    [[/FROM draft[\s\S]*FOR UPDATE/, [43, 7, '12'], []]],
  );
  await json(await send('POST', '/article', { draftId: '41', title: 'new' }), { data: mutation('INSERT', 12), code: 0 });
  await json(await send('POST', '/article', { draftId: '', contentJson: {} }), { msg: '参数错误: contentJson 不能为空', code: 400 }, 400);
  await json(await send('PUT', '/article/12', { draftId: 42, title: 'edit' }), { data: mutation('UPDATE'), code: 0 });
  await json(await send('PUT', '/article/12', { draftId: 43, title: 'edit' }), { msg: '草稿不存在', code: 404 }, 404);
  assert.deepEqual(events, ['commit', 'rollback', 'commit', 'rollback'].flatMap(event => ['connection', 'begin', event, 'release']));
});

test('article likes publish only after the database commit and release', async t => {
  const { send, reads, transactions, events } = await fixture(t);
  const notification = { id: 99, recipientId: 8, actorId: 7, type: 'article_like' };
  const like: Query[] = [
    [/^DELETE FROM article_like/, ['12', 7], mutation('DELETE', 0, 0)],
    [/SELECT user_id AS "authorId"/, ['12'], [{ authorId: 8 }]],
    [/^INSERT INTO article_like/, ['12', 7], mutation('INSERT')],
    [/pg_advisory_xact_lock/, ['article_like:8:7:article:12'], []],
    [/ORDER BY created_at DESC/, [8, 7, 'article_like', 'article', '12'], []],
  ];
  const insert = [8, 7, 'article_like', 'article', '12', '12', null, '{}'];
  transactions.push(
    [...like, [/INSERT INTO notifications/, insert, mutation('INSERT', 99)], [/WHERE n.id =/, [99], [notification]]],
    [...like, [/INSERT INTO notifications/, insert, new Error('notification unavailable')]],
  );
  reads.push(
    [/^SELECT status FROM/, [7], [{ status: 0 }]], [/COUNT\(al.user_id\) likes/, ['12'], [{ likes: '2' }]],
    [/^SELECT status FROM/, [7], [{ status: 0 }]],
  );
  await json(await send('POST', '/article/12/like'), { data: { liked: true, likes: '2' }, code: 0 });
  await json(await send('POST', '/article/12/like'), { msg: '服务器内部错误', code: 500 }, 500);
  assert.deepEqual(events, ['connection', 'begin', 'commit', 'release', notification, 'connection', 'begin', 'rollback', 'release']);
});

test('article deletion gates video processing and removes local media only after its durable cleanup write commits', async t => {
  const { send, reads, transactions, events, imageRoot } = await fixture(t);
  const guarded = /^SELECT \* FROM article/;
  const owned = /^SELECT id FROM article[\s\S]*FOR UPDATE/;
  const files = /^SELECT f.id[\s\S]*FOR UPDATE OF f/;
  const image = { id: 31, file_type: 'image', filename: 'media.png' };
  await writeFile(join(imageRoot, 'media.png'), 'local');
  reads.push([guarded, ['12', 7], [{ id: 12 }]], [guarded, ['12', 7], [{ id: 12 }]]);
  const entries = [
    { id: 1, storageArea: 'image', filename: 'media.png', attemptCount: 0 },
    { id: 2, storageArea: 'image', filename: 'media-small.png', attemptCount: 0 },
  ];
  transactions.push(
    [[owned, [12, 7], [{ id: 12 }]], [files, [12], [{ id: 33, file_type: 'video', transcode_status: 'processing' }]]],
    [
      [owned, [12, 7], [{ id: 12 }]], [files, [12], [image]],
      [/^INSERT INTO media_local_cleanup/, ['image', 'media.png'], mutation('INSERT', 1)],
      [/^INSERT INTO media_local_cleanup/, ['image', 'media-small.png'], mutation('INSERT', 2)],
      [/^DELETE FROM file/, [12], mutation('DELETE')],
      [/^DELETE FROM article /, [12, 7], mutation('DELETE')],
    ],
    [[/FROM media_object/, [[31]], []]],
    [
      [/FROM media_local_cleanup[\s\S]*LIMIT/, [[1, 2], 100], entries],
      [/FOR UPDATE SKIP LOCKED/, [[1, 2]], entries],
      [/^DELETE FROM media_local_cleanup/, [1], mutation('DELETE')],
      [/^DELETE FROM media_local_cleanup/, [2], mutation('DELETE')],
    ],
  );
  await json(await send('DELETE', '/article/12'), { msg: '视频仍在处理中，请稍后重试删除文章（视频 ID: 33）', code: 409 }, 409);
  assert.equal(await readFile(join(imageRoot, 'media.png'), 'utf8'), 'local');
  await json(await send('DELETE', '/article/12'), { data: mutation('DELETE'), code: 0 });
  await assert.rejects(readFile(join(imageRoot, 'media.png')), { code: 'ENOENT' });
  assert.deepEqual(events, [
    'connection', 'begin', 'rollback', 'release',
    'connection', 'begin', 'connection', 'begin', 'commit', 'release', 'commit', 'release',
    'connection', 'begin', 'commit', 'release',
  ]);
});
