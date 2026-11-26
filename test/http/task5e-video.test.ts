import { frozenHttpContract } from '../support/frozen-http-contract.js';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import jwt from 'jsonwebtoken';
import { MAX_VIDEO_FILE_SIZE, VIDEO_TYPE_LIMIT_MESSAGE } from '../../src/constants/upload.js';
import BusinessError from '../../src/errors/BusinessError.js';
import { createHttpApp } from '../../src/http/app.js';
import { createVerifyAuth } from '../../src/middleware/auth.middleware.js';
import { createDiskUpload } from '../../src/middleware/diskUpload.middleware.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';
import { registerVideoRoutes } from '../../src/router/video.router.js';
import { createVideoService } from '../../src/service/video.factory.js';
import { createVideoOperations } from '../../src/service/videoOperations.factory.js';
import type { VideoFileRow, VideoOperationsDependencies, VideoStore, VideoUrlResolver } from '../../src/service/video.types.js';

const origin = 'https://api.example.test';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const authorization = `Bearer ${jwt.sign({ id: '007' }, keys.privateKey, { algorithm: 'RS256' })}`;
const logger = { info() {}, warn() {}, error() {} };

function storeFixture(calls: unknown[][]) {
  const initialRow: VideoFileRow = {
    id: 29, filename: 'existing.mp4', poster: ' existing-poster.jpg ', transcode_status: 'completed',
    user_id: 7, size: 325, created_at: new Date('2026-11-10T00:00:00Z'),
  };
  const rows = new Map([['29', initialRow]]);
  const store: VideoStore = {
    async addVideo(userId, filename, mimetype, size) {
      calls.push(['add', userId, filename, mimetype, size]);
      rows.set('17', { id: 17, filename, poster: null, transcode_status: 'pending' });
      return { insertId: 17 };
    },
    async updateTranscodeStatus(id, status) {
      calls.push(['status', id, status]);
      const row = rows.get(String(id));
      assert.ok(row);
      row.transcode_status = status;
    },
    async updateVideoMetadata(id, metadata) {
      calls.push(['metadata', id, metadata]);
      Object.assign(rows.get(String(id)) ?? {}, metadata);
    },
    async updateVideoPoster(id, poster) {
      calls.push(['poster', id, poster]);
      Object.assign(rows.get(String(id)) ?? {}, { poster });
    },
    async promotePublishedVideoIds(ids) { calls.push(['promote', ids]); },
    async updateVideoArticle(articleId, ids, userId) {
      calls.push(['associate', articleId, ids, userId]);
      if (articleId === 'invalid') throw new BusinessError('参数错误: articleId 和 userId 必须是正整数', 400);
      if (articleId === '33') throw new BusinessError('文章不存在或无权关联视频', 403);
      return { success: true, affectedRows: ids.length, deletedCount: ids.length === 0 ? 1 : 0 };
    },
    async deleteVideos(ids, userId) {
      calls.push(['delete', ids, userId]);
      if (ids.includes(33)) throw new BusinessError('无权删除部分视频，或视频不存在', 403);
      const videosToDelete = ids.map(id => rows.get(String(id))).filter(row => row !== undefined);
      return { videosToDelete, localCleanup: { pendingIds: [] } };
    },
    async getVideoById(id) { calls.push(['get', id]); return rows.get(id); },
  };
  const mediaRuntime: VideoUrlResolver = {
    async resolveVideoUrl(id) {
      calls.push(['resolve video', id]);
      return id === 29 ? 'https://media.example.test/clip.mp4' : null;
    },
    async resolveVideoPosterUrl(id) { calls.push(['resolve poster', id]); return null; },
  };
  return { store, mediaRuntime };
}

function candidateFixture(options: { calls: unknown[][]; root: string; paused?: () => boolean; dependencies?: Partial<VideoOperationsDependencies> }) {
  const { calls, root, paused = () => false, dependencies } = options;
  const { store, mediaRuntime } = storeFixture(calls);
  const operations = createVideoOperations({
    service: store, mediaRuntime, baseURL: origin, videoRoot: root, logger,
    async runProcess(program) { throw new Error(`Unexpected ${program} in this test`); },
    ...dependencies,
  });
  const app = createHttpApp({
    buildId: 'video-test', checkReady: async () => false,
    registerRoutes(app) {
      registerVideoRoutes(app, {
        operations,
        maintenance: mediaMutationMaintenance(paused),
        verifyAuth: createVerifyAuth(keys.publicKey),
        uploadVideo: createDiskUpload({
          root, field: 'video', maxBytes: MAX_VIDEO_FILE_SIZE, mimePrefix: 'video/', mimeError: VIDEO_TYPE_LIMIT_MESSAGE,
        }),
      });
    },
  });
  return { app, operations, service: dependencies?.service ?? store };
}

function trackServer(t: TestContext, server: { close(callback: (error?: Error) => void): unknown }) {
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
}

function rawRequest(server: { address: Server['address'] }, method: string, path: string, json?: unknown, authenticated = false) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return new Promise((resolve, reject) => {
    const body = json === undefined ? undefined : JSON.stringify(json);
    const headers: Record<string, string | number> = { connection: 'close' };
    if (authenticated) headers.authorization = authorization;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = request({ host: '127.0.0.1', port: address.port, method, path, headers, signal: AbortSignal.timeout(5_000) }, response => {
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

test('video routes preserve Koa guards, parameter coercion, public detail and method headers', async t => {
  let paused = false;
  const calls: unknown[][] = [];
  const { app } = candidateFixture({ calls, root: tmpdir(), paused: () => paused });
  const candidate = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  trackServer(t, candidate);
  await once(candidate, 'listening');

  const contract = frozenHttpContract('video');
  async function compare(method: string, path: string, expectedCalls: unknown[][], body?: unknown, authenticated = false) {
    contract.assert(method, path, await rawRequest(candidate, method, path, body, authenticated));
    assert.deepEqual(calls.splice(0), expectedCalls);
  }

  await compare('GET', '/ViDeO/29/', [['get', '29'], ['resolve video', 29], ['resolve poster', 29]]);
  await compare('HEAD', '/video/29', [['get', '29'], ['resolve video', 29], ['resolve poster', 29]]);
  await compare('GET', '/video/%31%37', [['get', '17']]);
  await compare('GET', '/video/not-an-id', [['get', 'not-an-id']]);
  await compare('GET', '/v%69deo/29', []);
  await compare('OPTIONS', '/VIDEO/29/', []);
  await compare('PUT', '/video', []);
  paused = true;
  await compare('POST', '/video', []);
  await compare('POST', '/video/30', [], { videoIds: [29] });
  await compare('DELETE', '/video', [], { videoIds: [29] });
  await compare('GET', '/video/17', [['get', '17']]);
  paused = false;
  await compare('POST', '/video', []);
  await compare('POST', '/video', [], undefined, true);
  await compare('POST', '/video/30', [['associate', '30', [], '007']], { videoIds: [] }, true);
  await compare('POST', '/VIDEO/30/', [['associate', '30', [1, 29], '007']], { videoIds: [true, ['29']] }, true);
  await compare('POST', '/video/30', [], { videoIds: [29, '29'] }, true);
  await compare('POST', '/video/30', [], { videoIds: [1, 2, 3] }, true);
  await compare('POST', '/video/invalid', [['associate', 'invalid', [], '007']], { videoIds: [] }, true);
  await compare('POST', '/video/33', [['associate', '33', [29], '007']], { videoIds: [29] }, true);
  await compare('DELETE', '/VIDEO/', [['delete', [29], '007']], { videoIds: ['29', -2, 29] }, true);
  await compare('DELETE', '/video', [['delete', [33], '007']], { videoIds: [33] }, true);
  contract.assertComplete();
});

test('video removal leaves local files to the durable deletion service', async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-delete-contract-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'clip.mp4'), 'retained');
  await writeFile(join(root, 'clip-poster.jpg'), 'retained');
  const calls: unknown[][] = [];
  const { store } = storeFixture([]);
  let failed = false;
  const { app } = candidateFixture({ root, calls, dependencies: {
    service: { ...store, async deleteVideos(ids, userId) {
      calls.push([ids, userId]);
      if (failed) throw new Error('R2 upload is still pending');
      return { videosToDelete: [{ id: 71, filename: 'clip.mp4', poster: 'clip-poster.jpg' }], localCleanup: { pendingIds: [] } };
    } },
    async removeFile() { assert.fail('The durable deletion service owns file removal'); },
  } });
  const remove = () => app.request('/video', {
    method: 'DELETE', headers: { authorization, 'content-type': 'application/json' }, body: '{"videoIds":[71]}',
  });
  const removed = await remove();
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { data: '已删除1个视频', code: 0 });
  failed = true;
  const pending = await remove();
  assert.equal(pending.status, 500);
  assert.deepEqual(await pending.json(), { msg: '服务器内部错误', code: 500 });
  assert.deepEqual(calls, [[[71], '007'], [[71], '007']]);
  assert.deepEqual((await readdir(root)).sort(), ['clip-poster.jpg', 'clip.mp4']);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function uploadFixture(t: TestContext, { failProbe = false, failInsert = false, service }: { failProbe?: boolean; failInsert?: boolean; service?: VideoStore } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coderx-5e-video-'));
  const calls: unknown[][] = [];
  const screen = deferred();
  const started = deferred();
  const processCalls: [string, string[]][] = [];
  const { app, operations, service: activeService } = candidateFixture({
    calls, root, dependencies: {
      ...(service ? { service } : {}),
      async runProcess(program, args) {
        processCalls.push([program, args]);
        if (program === 'ffprobe') {
          if (failProbe) throw new Error('injected ffprobe failure');
          return JSON.stringify({
            format: { duration: '2.35', bit_rate: '123456', format_name: 'mov,mp4,m4a' },
            streams: [{ codec_type: 'audio' }, { codec_type: 'video', height: 240, width: 320 }],
          });
        }
        const output = args.at(-1);
        assert.ok(output);
        await writeFile(output, 'fake screenshot');
        started.resolve();
        await screen.promise;
        return '';
      },
    },
  });
  if (failInsert) activeService.addVideo = async () => { throw new Error('injected insert failure'); };
  t.after(async () => {
    screen.resolve();
    await operations.stop();
    await rm(root, { force: true, recursive: true });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  trackServer(t, server);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const form = new FormData();
  form.append('video', new Blob(['fake video'], { type: 'video/mp4' }), 'clip.mp4');
  const response = await fetch(`http://127.0.0.1:${address.port}/video`, {
    method: 'POST', headers: { authorization, connection: 'close' }, body: form, signal: AbortSignal.timeout(5_000),
  });
  return { app, operations, response, root, calls, processCalls, screen, started };
}

test('real Hono multipart upload responds while processing and drains before shutdown', async t => {
  const { app, operations, response, root, calls, processCalls, screen, started } = await uploadFixture(t);
  assert.equal(response.status, 200);
  const body = await response.json();
  const filename = body.data.filename;
  assert.match(filename, /^[\da-f-]+\.mp4$/);
  assert.deepEqual(body, { code: 0, data: {
    id: 17, url: `${origin}/article/video/${filename}`, poster: null, filename, transcodeStatus: 'processing',
  } });
  await started.promise;
  const initial = await app.request('/video/17');
  assert.deepEqual(await initial.json(), { code: 0, data: {
    id: 17, filename, url: `${origin}/article/video/${filename}`, poster: null, transcode_status: 'processing',
  } });
  assert.deepEqual(calls.slice(0, 3), [
    ['add', '007', filename, 'video/mp4', 10], ['status', 17, 'processing'], ['status', 17, 'processing'],
  ]);
  const posterFilename = filename.replace(/\.mp4$/, '-poster.jpg');
  assert.deepEqual(processCalls, [
    ['ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', join(root, filename)]],
    ['ffmpeg', ['-y', '-ss', '0', '-i', join(root, filename), '-frames:v', '1', '-vf', 'scale=640:-2', join(root, posterFilename)]],
  ]);
  let drained = false;
  const stop = operations.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  screen.resolve();
  await stop;
  assert.deepEqual(calls.slice(-4), [
    ['metadata', 17, { duration: 2, width: 320, height: 240, bitrate: 123, format: 'mov' }],
    ['poster', 17, posterFilename], ['status', 17, 'completed'], ['promote', [17]],
  ]);
  const completed = await app.request('/video/17');
  const data = (await completed.json()).data;
  assert.equal(data.transcode_status, 'completed');
  assert.equal(data.poster, `${origin}/article/video/${posterFilename}`);
  assert.deepEqual((await readdir(root)).sort(), [filename, posterFilename].sort());
});

test('video stays processing until both processes exit and cleans an uncommitted poster on probe failure', async t => {
  const { app, operations, response, calls, root, screen, started } = await uploadFixture(t, { failProbe: true });
  assert.equal(response.status, 200);
  const { data: { filename } } = await response.json();
  await started.promise;
  const pending = await app.request('/video/17');
  assert.equal((await pending.json()).data.transcode_status, 'processing');
  screen.resolve();
  await operations.stop();
  assert.deepEqual(calls.at(-1), ['status', 17, 'failed']);
  assert.equal(calls.some(([operation]) => operation === 'promote'), false);
  const failed = await app.request('/video/17');
  assert.deepEqual(await failed.json(), { code: 0, data: {
    id: 17, filename, url: `${origin}/article/video/${filename}`, poster: null, transcode_status: 'failed',
  } });
  assert.deepEqual(await readdir(root), [filename]);
});

test('failed video insert returns the legacy system envelope and removes the uncommitted upload', async t => {
  const { response, root, processCalls } = await uploadFixture(t, { failInsert: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { msg: '服务器内部错误', code: 500 });
  assert.deepEqual(processCalls, []);
  assert.deepEqual(await readdir(root), []);
});


test('a failed commit acknowledgement preserves a video file that may have a committed row', async t => {
  const service = createVideoService({
    logger,
    connection: {
      async execute() { throw new Error('Unexpected root query'); },
      async getConnection() {
        return {
          async beginTransaction() {},
          async execute() { return [{ insertId: 17, affectedRows: 1 }, []]; },
          async commit() { throw new Error('Connection closed during commit'); },
          async rollback() {},
          release() {},
        };
      },
    },
    mediaRuntime: {
      async promotePublishedVideos() { throw new Error('Unexpected promotion'); },
      async deleteR2ObjectsForFiles() { throw new Error('Unexpected R2 deletion'); },
    },
    localMediaCleanup: {
      buildLocalCleanupEntries() { throw new Error('Unexpected cleanup'); },
      async enqueueInTransaction() { throw new Error('Unexpected cleanup'); },
      async processPending() { throw new Error('Unexpected cleanup'); },
    },
  });
  const { response, root, processCalls } = await uploadFixture(t, { service });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { msg: '服务器内部错误', code: 500 });
  assert.deepEqual(processCalls, []);
  assert.equal((await readdir(root)).length, 1);
});
