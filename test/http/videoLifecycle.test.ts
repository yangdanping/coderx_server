import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { createShutdown } from '../../src/app/shutdown.js';
import { createHttpApp } from '../../src/http/app.js';
import { createDiskUpload } from '../../src/middleware/diskUpload.middleware.js';
import { registerVideoRoutes } from '../../src/router/video.router.js';
import { createVideoOperations } from '../../src/service/videoOperations.factory.js';
import type { VideoStore } from '../../src/service/video.types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('shutdown waits for a disconnected upload in the insert phase and for its background work', { timeout: 5_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coderx-task6-video-'));
  const inserting = deferred();
  const committed = deferred();
  const posterStarted = deferred();
  const posterFinished = deferred();
  const events: string[] = [];
  const service: VideoStore = {
    async addVideo() {
      events.push('pending');
      inserting.resolve();
      await committed.promise;
      return { insertId: 73 };
    },
    async updateTranscodeStatus(_id, status) { events.push(status); },
    async updateVideoMetadata() { events.push('metadata'); },
    async updateVideoPoster() { events.push('poster'); },
    async promotePublishedVideoIds() { events.push('promote'); },
    async updateVideoArticle() { throw new Error('unexpected association'); },
    async deleteVideos() { throw new Error('unexpected deletion'); },
    async getVideoById() { throw new Error('unexpected read'); },
  };
  const operations = createVideoOperations({
    service, baseURL: 'https://api.example.test', videoRoot: root,
    logger: { info() {}, warn() {}, error() {} },
    mediaRuntime: { async resolveVideoUrl() { return null; }, async resolveVideoPosterUrl() { return null; } },
    async runProcess(program, args) {
      if (program === 'ffprobe') return JSON.stringify({ streams: [], format: {} });
      const target = args.at(-1);
      assert.ok(target);
      posterStarted.resolve();
      await posterFinished.promise;
      await writeFile(target, 'poster fixture');
      return '';
    },
  });
  const app = createHttpApp({
    buildId: 'task6-video', checkReady: async () => false,
    registerRoutes(app) {
      registerVideoRoutes(app, {
        operations, uploadVideo: createDiskUpload({ root, field: 'video', maxBytes: 1024 }),
        async maintenance(_c, next) { await next(); },
        async verifyAuth(c, next) { c.set('user', { id: 7 }); await next(); },
      });
    },
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(async () => {
    committed.resolve();
    posterFinished.resolve();
    if (server.listening) server.close();
    await operations.stop();
    await rm(root, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const body = '--video\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\nvideo bytes\r\n--video--\r\n';
  const client = request({
    host: '127.0.0.1', port: address.port, path: '/video', method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=video', 'content-length': body.length },
  });
  client.on('error', () => {});
  client.end(body);
  await inserting.promise;
  client.destroy();
  const listenerClosed = once(server, 'close');
  const stop = createShutdown([() => { events.push('close database and media runtime'); }], [{
    async stop() {
      server.close();
      await listenerClosed;
      await operations.stop();
    },
  }], 2_000);
  const drained = stop();
  await listenerClosed;
  await setImmediate();
  assert.deepEqual(events, ['pending']);
  committed.resolve();
  await posterStarted.promise;
  await setImmediate();
  assert.ok(!events.includes('close database and media runtime'));
  posterFinished.resolve();
  await drained;
  assert.deepEqual(events, ['pending', 'processing', 'processing', 'metadata', 'poster', 'completed', 'promote', 'close database and media runtime']);
  assert.equal((await readdir(root)).length, 2);
});
