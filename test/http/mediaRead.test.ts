import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rename, rm, symlink, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { createHttpApp } from '../../src/http/app.js';
import { localFileResponse, openLocalMedia } from '../../src/http/fileResponseBody.js';

test('Node media delivery reads the checked descriptor and closes it after a client disconnect', { timeout: 5_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coderx-task6-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'video.mp4');
  const prefix = 'video fixture';
  const size = 32 * 1024 * 1024;
  await writeFile(path, prefix);
  await truncate(path, size);
  const substitute = join(root, 'replacement.txt');
  await writeFile(substitute, 'replacement');

  let markOpened!: (handle: FileHandle) => void;
  const opened = new Promise<FileHandle>(done => { markOpened = done; });
  const app = createHttpApp({
    buildId: 'task6-media-read', checkReady: async () => false,
    registerRoutes(app) {
      app.get('/video', async c => {
        const file = await openLocalMedia(root, 'video.mp4');
        if (!file) return c.notFound();
        markOpened(file.handle);
        await rename(path, join(root, 'original.mp4'));
        await symlink(substitute, path);
        c.header('Content-Length', String(file.size));
        return localFileResponse(c, file, 'video/mp4');
      });
    },
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/video`;
  const response = await new Promise<Buffer>((resolve, reject) => {
    const client = get(url, res => {
      try {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-length'], String(size));
        assert.equal(res.headers['content-type'], 'video/mp4');
        res.once('data', (chunk: Buffer) => {
          res.destroy();
          resolve(chunk);
        });
        res.once('error', reject);
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    client.once('error', reject);
  });
  assert.equal(response.subarray(0, prefix.length).toString(), prefix);
  const handle = await opened;
  for (let attempt = 0; attempt < 100 && handle.fd !== -1; attempt++) await setTimeout(10);
  assert.equal(handle.fd, -1);

  const absent = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
  assert.equal(absent.status, 404);
  assert.equal(await absent.text(), '');
});


test('response setup closes the descriptor when stored MIME cannot be sent as a header', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coderx-task6-read-header-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'image.png'), 'fixture');
  const file = await openLocalMedia(root, 'image.png');
  assert.ok(file);
  t.after(() => file.handle.close());
  const app = createHttpApp({
    buildId: 'task6-media-header', checkReady: async () => false,
    registerRoutes(app) {
      app.get('/image', c => localFileResponse(c, file, 'image/渲染'));
    },
  });
  const response = await app.request('/image');
  assert.equal(response.status, 500);
  assert.equal(file.handle.fd, -1);
});
