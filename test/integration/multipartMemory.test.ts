import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { MAX_IMAGE_BATCH_COUNT, MAX_IMAGE_FILE_SIZE } from '../../src/constants/upload.js';
import { createHttpApp } from '../../src/http/app.js';
import { createDiskUpload } from '../../src/middleware/diskUpload.middleware.js';

const MiB = 1024 * 1024;

test('streaming multipart keeps retained Buffer memory bounded as the batch grows', { timeout: 30_000 }, async t => {
  assert.ok(global.gc, 'Run this isolated check with --expose-gc');
  const collectGarbage = global.gc;
  const root = await mkdtemp(join(tmpdir(), 'coderx-task6-upload-memory-'));
  const app = createHttpApp({
    buildId: 'multipart-memory', checkReady: async () => false,
    registerRoutes(app) {
      app.post('/img', createDiskUpload({
        root, field: 'img', maxCount: MAX_IMAGE_BATCH_COUNT, maxBytes: MAX_IMAGE_FILE_SIZE,
      }), c => c.json(c.get('diskUploads')?.map(file => file.size)));
    },
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const { port } = address;
    const chunk = Buffer.alloc(64 * 1024, 33);

    async function upload(count: number) {
      collectGarbage();
      const baseline = process.memoryUsage();
      let maxRetained = 0;
      let peakRss = baseline.rss;
      const client = request({
        host: '127.0.0.1', port, path: '/img', method: 'POST',
        headers: { connection: 'close', 'content-type': 'multipart/form-data; boundary=memory' },
      });
      const response = new Promise<void>((done, fail) => {
        client.once('error', fail);
        client.once('response', async res => {
          try {
            let body = '';
            for await (const bytes of res.setEncoding('utf8')) body += bytes;
            assert.equal(res.statusCode, 200);
            assert.deepEqual(JSON.parse(body), Array<number>(count).fill(MAX_IMAGE_FILE_SIZE));
            done();
          } catch (error) { fail(error); }
        });
      });
      void response.catch(() => {});
      try {
        for (let file = 0; file < count; file++) {
          client.write('--memory\r\nContent-Disposition: form-data; name="img"; filename="blob.png"\r\nContent-Type: image/png\r\n\r\n');
          for (let offset = 0; offset < MAX_IMAGE_FILE_SIZE; offset += chunk.length) {
            if (!client.write(chunk)) await once(client, 'drain');
            if ((offset + chunk.length) % (5 * MiB) === 0) {
              await setImmediate();
              peakRss = Math.max(peakRss, process.memoryUsage().rss);
              collectGarbage();
              maxRetained = Math.max(maxRetained, process.memoryUsage().arrayBuffers - baseline.arrayBuffers);
            }
          }
          client.write('\r\n');
        }
        client.end('--memory--\r\n');
        await response;
      } finally {
        client.destroy();
      }
      return { payloadMiB: count * MAX_IMAGE_FILE_SIZE / MiB, maxRetained, peakRssGrowth: peakRss - baseline.rss };
    }

    // Warm the HTTP and filesystem paths before comparing the larger transfers.
    await upload(1);
    const small = await upload(2);
    const large = await upload(12);
    t.diagnostic(JSON.stringify({ small, large }));
    assert.ok(large.maxRetained < 16 * MiB, 'the 240 MiB batch must not retain a similarly sized Buffer');
    assert.ok(large.maxRetained - small.maxRetained < 8 * MiB);
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
});
