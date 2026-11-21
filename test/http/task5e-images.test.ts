import BusinessError from '../../src/errors/BusinessError.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import sharp from 'sharp';
import type { MiddlewareHandler } from 'hono';
import {
  IMAGE_BATCH_COUNT_LIMIT_MESSAGE, IMAGE_TYPE_LIMIT_MESSAGE, MAX_IMAGE_BATCH_COUNT, MAX_IMAGE_FILE_SIZE,
} from '../../src/constants/upload.js';
import { createDiskUpload } from '../../src/middleware/diskUpload.middleware.js';
import type { AppEnv, AuthUser } from '../../src/http/types.js';
import type { ArticleCleanup, ArticleDatabase } from '../../src/service/article/article.types.js';
import { createAvatarMutationService } from '../../src/service/avatar/avatar.service.js';
import { createImageService } from '../../src/service/image/image.service.js';
import { createMediaImageDeletionService } from '../../src/service/mediaImage/mediaImageDeletion.service.js';
import test from 'node:test';
import { createHttpApp } from '../../src/http/app.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';
import { registerAvatarRoutes } from '../../src/router/avatar.router.js';
import { registerImageRoutes } from '../../src/router/image.router.js';
import { registerMediaRoutes } from '../../src/router/media.router.js';

test('avatar, article image and media routes are mounted with their legacy methods', async () => {
  const app = createHttpApp({
    buildId: 'test',
    checkReady: async () => false,
    registerRoutes(app) {
      const maintenance = mediaMutationMaintenance(() => true);
      function unexpected(): never { assert.fail('route must stop before invoking dependencies'); }
      registerAvatarRoutes(app, {
        verifyAuth: unexpected, uploadAvatar: unexpected,
        service: { saveAvatar: unexpected, deleteAvatar: unexpected },
      });
      registerImageRoutes(app, {
        publicApiOrigin: 'https://api.example.test',
        maintenance, verifyAuth: unexpected, uploadImage: unexpected,
        service: { addImage: unexpected, updateImageArticle: unexpected, deleteOwnedUnattachedImages: unexpected },
      });
      registerMediaRoutes(app, {
        maintenance,
        verifyAuth() { assert.fail('paused media routes must not authenticate'); },
        uploadImage() { assert.fail('paused media routes must not upload'); },
        service: { createPendingImage: unexpected, deletePendingImage: unexpected },
      });
    },
  });

  for (const [method, path, status] of [
    ['OPTIONS', '/AVATAR/', 200],
    ['OPTIONS', '/AVATAR/17/', 200],
    ['POST', '/IMG/', 503],
    ['POST', '/IMG/12/', 503],
    ['DELETE', '/IMG/', 503],
    ['DELETE', '/MEDIA/IMAGES/14/', 503],
  ] as const) {
    const response = await app.request(path, { method });
    assert.equal(response.status, status, `${method} ${path}`);
  }
});

const publicApiOrigin = 'https://api.example.test';
const maintenance = mediaMutationMaintenance(() => false);
function unexpected(): never { assert.fail('route called an unexpected dependency'); }
function authenticate(user: AuthUser): MiddlewareHandler<AppEnv> {
  return async (c, next) => { c.set('user', user); await next(); };
}

async function withServer(app: ReturnType<typeof createHttpApp>, run: (origin: string) => Promise<void>) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
  }
}

async function expectJson(response: Response, status: number, expected: unknown) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await response.text();
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)));
  assert.deepEqual(JSON.parse(body), expected);
}

function appendFile(form: FormData, field: string, filename: string, mimeType: string, bytes: string | Uint8Array<ArrayBuffer>) {
  form.append(field, new Blob([bytes], { type: mimeType }), filename);
}

test('avatar owner deletion accepts numeric and string identities and rejects invalid ownership before service access', async () => {
  for (const [user, path, allowed] of [
    [{ id: 7 }, '/AVATAR/7/', true],
    [{ id: '7' }, '/avatar/007', true],
    [{ id: 8 }, '/avatar/7', false],
    [{ id: true }, '/avatar/1', false],
    [{}, '/avatar/7', false],
  ] as const) {
    let deletions = 0;
    const app = createHttpApp({
      buildId: 'test',
      checkReady: async () => false,
      registerRoutes(app) {
        registerAvatarRoutes(app, {
          verifyAuth: authenticate(user), uploadAvatar: unexpected,
          service: { saveAvatar: unexpected, async deleteAvatar() { deletions++; return '无头像可删除'; } },
        });
      },
    });
    const response = await app.request(path, { method: 'DELETE' });
    if (allowed) await expectJson(response, 200, { data: '无头像可删除', code: 0 });
    else await expectJson(response, 403, { msg: '不具备操作的权限', code: 403 });
    assert.equal(deletions, Number(allowed));
  }
});

test('Node avatar upload transaction replaces the old file only after commit and compensates a failed replacement', async t => {
  const avatarRoot = await mkdtemp(join(tmpdir(), 'task5e-avatar-'));
  t.after(() => rm(avatarRoot, { recursive: true, force: true }));
  const oldFile = 'old.png';
  const oldSmall = 'old-small.png';
  await writeFile(join(avatarRoot, oldFile), 'old avatar');
  await writeFile(join(avatarRoot, oldSmall), 'old thumbnail');
  const calls: string[] = [];
  let failWrite = true;
  let failCommit = false;
  let uploadName: string;
  const conn = {
    async beginTransaction() { calls.push('begin'); },
    async execute(sql: string, params: unknown[]) {
      if (sql.startsWith('DELETE')) {
        assert.deepEqual(params, [8]);
        calls.push('delete old');
        return [{ affectedRows: 1 }, []] as const;
      }
      assert.match(sql, /INSERT INTO avatar/);
      const [userId, filename, mimetype, size] = params;
      assert.equal(userId, 7);
      assert.equal(typeof filename, 'string');
      uploadName = String(filename);
      assert.match(uploadName, /^[a-f0-9-]+\.bin$/);
      assert.equal(mimetype, 'application/octet-stream');
      assert.equal(size, 5);
      assert.equal(await readFile(join(avatarRoot, uploadName), 'utf8'), 'bytes');
      calls.push('insert new');
      return [{ insertId: 19, affectedRows: 1 }, []] as const;
    },
    async commit() {
      await access(join(avatarRoot, oldFile));
      calls.push('commit');
      if (failCommit) throw new Error('commit acknowledgement lost');
    },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
  };
  const service = createAvatarMutationService({
    avatarRoot, publicApiOrigin,
    database: {
      async execute(sql, params) {
        assert.match(sql, /SELECT \* FROM avatar/);
        if (params?.[0] === '7') return [[{ id: 19, filename: uploadName, mimetype: 'application/octet-stream' }], []];
        assert.deepEqual(params, [7]);
        calls.push('find old');
        return [[{ id: 8, filename: oldFile, mimetype: 'image/png' }], []];
      },
      async getConnection() { return conn; },
    },
    async updateAvatarUrl(url, userId, transaction) {
      assert.equal(url, `${publicApiOrigin}/user/7/avatar`);
      assert.equal(userId, 7);
      assert.equal(transaction, conn);
      calls.push('profile URL');
      if (failWrite) throw new Error('profile write failed');
    },
  });
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => false,
    registerRoutes(app) {
      registerAvatarRoutes(app, { verifyAuth: authenticate({ id: 7 }), service, uploadAvatar: createDiskUpload({ root: avatarRoot, field: 'avatar' }) });
    },
  });
  await withServer(app, async origin => {
    const upload = () => {
      const form = new FormData();
      appendFile(form, 'avatar', 'fixture.bin', 'application/octet-stream', 'bytes');
      return fetch(origin + '/AVATAR/', { method: 'POST', body: form });
    };
    await expectJson(await upload(), 500, { msg: '服务器内部错误', code: 500 });
    assert.deepEqual(calls.splice(0), ['begin', 'find old', 'delete old', 'insert new', 'profile URL', 'rollback', 'release']);
    assert.deepEqual((await readdir(avatarRoot)).sort(), [oldSmall, oldFile]);
    failWrite = false;
    failCommit = true;
    await expectJson(await upload(), 500, { msg: '服务器内部错误', code: 500 });
    assert.deepEqual(calls.splice(0), ['begin', 'find old', 'delete old', 'insert new', 'profile URL', 'commit', 'rollback', 'release']);
    assert.deepEqual((await readdir(avatarRoot)).sort(), [oldSmall, oldFile, uploadName].sort());
    await rm(join(avatarRoot, uploadName));
    failCommit = false;
    await expectJson(await upload(), 200, { data: { insertId: 19, affectedRows: 1, avatarUrl: `${publicApiOrigin}/user/7/avatar` }, code: 0 });
    assert.deepEqual(calls, ['begin', 'find old', 'delete old', 'insert new', 'profile URL', 'commit', 'release']);
    assert.deepEqual(await readdir(avatarRoot), [uploadName]);
    await expectJson(await fetch(origin + '/avatar', { method: 'POST' }), 500, { msg: '服务器内部错误', code: 500 });
    await expectJson(await fetch(origin + '/avatar', { method: 'POST', body: new FormData() }), 500, { msg: '服务器内部错误', code: 500 });
  });
});

test('avatar service preserves its committed upload if removing the previous file fails', async t => {
  const avatarRoot = await mkdtemp(join(tmpdir(), 'task5e-avatar-commit-'));
  t.after(() => rm(avatarRoot, { recursive: true, force: true }));
  const filename = 'fresh.png';
  const path = join(avatarRoot, filename);
  await writeFile(path, 'committed image');
  const calls: string[] = [];
  const service = createAvatarMutationService({
    avatarRoot, publicApiOrigin,
    database: {
      async execute() { return [[{ id: 6, filename: 'old.png', mimetype: 'image/png' }], []]; },
      async getConnection() {
        return {
          async execute() { return [{ affectedRows: 1, insertId: 9 }, []]; },
          async beginTransaction() {},
          async commit() { calls.push('commit'); },
          rollback: unexpected,
          release() { calls.push('release'); },
        };
      },
    },
    async updateAvatarUrl() {},
    removeOldAvatar() {
      calls.push('old file cleanup');
      throw new Error('old file cleanup failed');
    },
  });
  await assert.rejects(service.saveAvatar(7, { filename, mimetype: 'image/png', size: 15, path }), /old file cleanup failed/);
  assert.deepEqual(calls, ['commit', 'release', 'old file cleanup']);
  assert.equal(await readFile(path, 'utf8'), 'committed image');
});

test('Node article image upload returns partial success and writes only the first thumbnail', async t => {
  const imageRoot = await mkdtemp(join(tmpdir(), 'task5e-image-batch-'));
  t.after(() => rm(imageRoot, { recursive: true, force: true }));
  const filenames: string[] = [];
  const calls: string[] = [];
  let failCommit = false;
  const service = createImageService({
    database: {
      execute: unexpected,
      async getConnection() {
        return {
          async beginTransaction() {},
          async commit() {
            calls.push('commit');
            if (failCommit) throw new Error('commit acknowledgement lost');
          },
          async rollback() { calls.push('rollback'); },
          release() {},
          async execute(sql, params) {
            if (sql.startsWith('INSERT INTO file')) {
              assert.equal(params?.[0], 7);
              assert.equal(params?.[2], 'image/png');
              filenames.push(String(params?.[1]));
              return [{ insertId: filenames.length, affectedRows: 1 }, []];
            }
            assert.match(sql, /INSERT INTO image_meta/);
            assert.deepEqual(params, [filenames.length, null, null]);
            if (filenames.length === 2) throw new Error('metadata write failed');
            return [{ affectedRows: 1 }, []];
          },
        };
      },
    },
    mediaRuntime: { deleteR2ObjectsForFiles: unexpected, promotePublishedImages: unexpected },
    localMediaCleanup: { buildLocalCleanupEntries: unexpected, enqueueInTransaction: unexpected, processPending: unexpected },
  });
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => false,
    registerRoutes(app) {
      registerImageRoutes(app, {
        service, publicApiOrigin, maintenance, verifyAuth: authenticate({ id: 7 }),
        uploadImage: createDiskUpload({ root: imageRoot, field: 'img', maxCount: MAX_IMAGE_BATCH_COUNT, maxBytes: MAX_IMAGE_FILE_SIZE, mimePrefix: 'image/', mimeError: IMAGE_TYPE_LIMIT_MESSAGE }),
      });
    },
  });
  const input = new Uint8Array(await sharp({ create: { width: 4, height: 3, channels: 3, background: 'orange' } }).png().toBuffer());
  await withServer(app, async origin => {
    const post = (body?: FormData) => fetch(origin + '/img', { method: 'POST', body });
    const form = new FormData();
    for (let i = 0; i < 3; i++) appendFile(form, 'img', 'same.png', 'image/png', input);
    const response = await post(form);
    const [first, second, third] = filenames;
    assert.equal(new Set(filenames).size, 3);
    assert.deepEqual(calls, ['commit', 'rollback', 'commit']);
    await expectJson(response, 200, {
      data: [first, third].map((filename, index) => ({ result: { insertId: index * 2 + 1, affectedRows: 1 }, url: `${publicApiOrigin}/article/images/${filename}` })),
      code: 0,
    });
    const thumbnail = first.replace('.png', '-small.png');
    assert.deepEqual((await readdir(imageRoot)).sort(), [first, third, thumbnail].sort());
    assert.equal((await sharp(join(imageRoot, thumbnail)).metadata()).width, 320);
    await assert.rejects(access(join(imageRoot, second)), { code: 'ENOENT' });
    await expectJson(await post(), 500, { msg: '服务器内部错误', code: 500 });
    await expectJson(await post(new FormData()), 200, { msg: '保存图片失败', code: -1 });
    const badType = new FormData();
    appendFile(badType, 'img', 'test.txt', 'text/plain', 'sample');
    await expectJson(await post(badType), 400, { msg: IMAGE_TYPE_LIMIT_MESSAGE, code: 400 });
    const wrongField = new FormData();
    appendFile(wrongField, 'image', 'test.png', 'image/png', input);
    await expectJson(await post(wrongField), 400, { msg: IMAGE_BATCH_COUNT_LIMIT_MESSAGE, code: 400 });
    const corrupt = new FormData();
    appendFile(corrupt, 'img', 'test.png', 'image/png', 'bad pixels');
    await expectJson(await post(corrupt), 500, { msg: '服务器内部错误', code: 500 });
    assert.deepEqual((await readdir(imageRoot)).sort(), [first, third, thumbnail].sort());

    failCommit = true;
    const pending = new FormData();
    appendFile(pending, 'img', 'uncertain.png', 'image/png', input);
    await expectJson(await post(pending), 200, { msg: '保存图片失败', code: -1 });
    const uncertainFile = filenames[3];
    const uncertainThumbnail = uncertainFile.replace('.png', '-small.png');
    assert.deepEqual(calls, ['commit', 'rollback', 'commit', 'commit', 'rollback']);
    assert.deepEqual((await readdir(imageRoot)).sort(), [first, third, thumbnail, uncertainFile, uncertainThumbnail].sort());
  });
});

test('image association and deletion preserve strict uploaded IDs, explicit cover selection and raw article ID', async () => {
  const calls: unknown[] = [];
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => false,
    registerRoutes(app) {
      registerImageRoutes(app, {
        publicApiOrigin, maintenance, verifyAuth: authenticate({ id: '7' }), uploadImage: unexpected,
        service: {
          addImage: unexpected,
          async updateImageArticle(userId, articleId, ids, cover) {
            calls.push(['associate', userId, articleId, ids, cover]);
            return { success: true, affectedRows: 2, deletedCount: 0, coverSet: !!cover };
          },
          async deleteOwnedUnattachedImages(userId, ids) {
            assert.ok(Array.isArray(ids));
            calls.push(['delete', userId, ids]);
            if (ids.includes(41)) throw new BusinessError('图片不可删除', 403);
            return {
              result: { affectedRows: 1 }, imagesToDelete: [{ id: 8, filename: 'fixture.png', file_type: 'image' }],
              localCleanup: { examined: 1, deleted: 1, missing: 0, failed: 0, pendingIds: [] },
            };
          },
        },
      });
    },
  });
  const request = (path: string, method: string, uploaded: unknown) => app.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploaded }),
  });
  const invalid = { msg: '上传数据格式错误', code: -1 };
  for (const value of [null, [{ id: '8' }], [{ id: 1.5 }], [{ id: Number.MAX_SAFE_INTEGER + 1 }], [null]]) {
    await expectJson(await request('/img/12', 'POST', value), 200, invalid);
    await expectJson(await request('/img', 'DELETE', value), 200, invalid);
  }
  await expectJson(await request('/IMG/%31%32/', 'POST', [{ id: 8, isCover: 1 }, { id: 9, isCover: true }]), 200, {
    data: { success: true, affectedRows: 2, deletedCount: 0, coverSet: true }, code: 0,
  });
  await expectJson(await request('/img/12', 'POST', []), 200, {
    data: { success: true, affectedRows: 2, deletedCount: 0, coverSet: false }, code: 0,
  });
  await expectJson(await request('/IMG/', 'DELETE', [{ id: 8 }]), 200, { data: '已删除1张图片成功', code: 0 });
  await expectJson(await request('/img', 'DELETE', [{ id: 41 }]), 403, { msg: '图片不可删除', code: 403 });
  assert.deepEqual(calls, [['associate', '7', '12', [8, 9], 9], ['associate', '7', '12', [], null], ['delete', '7', [8]], ['delete', '7', [41]]]);
});

test('media deletion coerces path IDs, handles absent images and runs cleanup only after commit', async () => {
  const calls: unknown[] = [];
  const localMediaCleanup: ArticleCleanup = {
    buildLocalCleanupEntries(rows) {
      assert.equal(rows[0].filename, 'pending.png');
      return [{ storageArea: 'image', filename: 'pending.png' }];
    },
    async enqueueInTransaction(transaction, entries) {
      assert.equal(transaction, conn);
      assert.deepEqual(entries, [{ storageArea: 'image', filename: 'pending.png' }]);
      calls.push('enqueue');
      return [67];
    },
    async processPending({ ids }) {
      assert.deepEqual(ids, [67]);
      calls.push('cleanup');
      return { examined: 1, deleted: 1, missing: 0, failed: 0, pendingIds: [] };
    },
  };
  const conn = {
    async beginTransaction() { calls.push('begin'); },
    async execute(sql: string, params: unknown[]) {
      if (sql.includes('SELECT f.id')) {
        if (sql.includes('FOR UPDATE')) assert.deepEqual(params, [7, 4]);
        else assert.equal(params.length, 1);
        if (params[0] === 8) return [[], []] as const;
        const row = { id: 7, user_id: 4, filename: 'pending.png', file_type: 'image', article_id: null, flow_id: null, draft_id: null };
        calls.push(sql.includes('FOR UPDATE') ? 'lock' : ['probe', params[0]]);
        return [[row], []] as const;
      }
      assert.match(sql, /DELETE FROM file/);
      assert.deepEqual(params, [7, 4]);
      calls.push('delete row');
      return [{ affectedRows: 1 }, []] as const;
    },
    async commit() { calls.push('commit'); },
    rollback: unexpected,
    release() { calls.push('release'); },
  };
  const database: Pick<ArticleDatabase, 'getConnection'> = { async getConnection() { return conn; } };
  const service = {
    createPendingImage: unexpected,
    deletePendingImage: createMediaImageDeletionService({
      database, localMediaCleanup,
      mediaRuntime: { async deleteR2ObjectsForFiles(ids) { calls.push(['delete R2', ids]); } },
    }),
  };
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => false,
    registerRoutes(app) {
      registerMediaRoutes(app, { maintenance, verifyAuth: authenticate({ id: 4 }), uploadImage: unexpected, service });
    },
  });
  const remove = (id: string) => app.request(`/MEDIA/IMAGES/${id}/`, { method: 'DELETE' });
  await expectJson(await remove('invalid'), 400, { msg: '参数错误: mediaId 必须是正整数', code: 400 });
  await expectJson(await remove('8'), 200, { data: { deleted: false }, code: 0 });
  assert.deepEqual(calls.splice(0), ['begin', 'commit', 'release']);
  await expectJson(await remove('0x7'), 200, { data: { deleted: true }, code: 0 });
  assert.deepEqual(calls, ['begin', ['probe', 7], 'lock', ['delete R2', [7]], 'enqueue', 'delete row', 'commit', 'release', 'cleanup']);
});
