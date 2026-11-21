import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { IMAGE_TYPE_LIMIT_MESSAGE } from '../../src/constants/upload.js';
import { createHttpApp } from '../../src/http/app.js';
import { createDiskUpload } from '../../src/middleware/diskUpload.middleware.js';

const boundary = 'task6-boundary';
const contentType = 'multipart/form-data; boundary=' + boundary;
const part = (field = 'img', type = 'image/png') => `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="test.png"\r\nContent-Type: ${type}\r\n\r\n`;
const end = `\r\n--${boundary}--\r\n`;

async function fixture(t: TestContext, maxRequestBytes: number, failDisk = false) {
  const root = await mkdtemp(join(tmpdir(), 'coderx-task6-multipart-'));
  const destination = join(root, 'img');
  if (failDisk) await writeFile(destination, 'keep');
  let handled = 0;
  let settled = 0;
  const app = createHttpApp({
    buildId: 'task6-multipart', checkReady: async () => false,
    registerRoutes(app) {
      app.post('/img', async (_c, next) => {
        await next();
        settled++;
      }, createDiskUpload({
        root: destination, field: 'img', maxCount: 2, maxBytes: maxRequestBytes, maxRequestBytes,
        mimePrefix: 'image/', mimeError: IMAGE_TYPE_LIMIT_MESSAGE,
      }), c => {
        handled++;
        return c.json(c.get('diskUploads')?.map(({ kind, size }) => ({ kind, size })));
      });
    },
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  function start(headers: Record<string, string> = {}) {
    const client = request({
      host: '127.0.0.1', port, path: '/img', method: 'POST',
      headers: { 'content-type': contentType, connection: 'close', ...headers },
    });
    const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
      client.once('error', reject);
      client.once('response', async incoming => {
        try {
          let body = '';
          for await (const chunk of incoming.setEncoding('utf8')) body += chunk;
          resolve({ status: incoming.statusCode, body });
        } catch (error) { reject(error); }
      });
    });
    void response.catch(() => {});
    return { client, response };
  }
  return { start, destination, handled: () => handled, settled: () => settled };
}

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await setTimeout(10);
  }
  throw new Error('condition did not settle');
}

test('multipart enforces declared and actual wire budgets including framing', { timeout: 5_000 }, async t => {
  const body = part() + 'x'.repeat(20) + end;
  const { start, destination, handled } = await fixture(t, Buffer.byteLength(body));
  const valid = start();
  valid.client.end(body);
  assert.deepEqual(await valid.response, { status: 200, body: '[{"kind":"disk","size":20}]' });
  const saved = await readdir(destination);

  const declared = start({ 'content-length': '999999' });
  declared.client.flushHeaders(); // Never send the advertised body.
  assert.equal((await declared.response).status, 413);
  declared.client.destroy();

  const chunked = start();
  chunked.client.write(part() + 'x'.repeat(30));
  chunked.client.write('x'.repeat(30)); // Intentionally leave the part open.
  assert.equal((await chunked.response).status, 413);
  chunked.client.destroy();

  const short = start({ 'content-length': String(body.length - 4) });
  short.client.end(body.slice(0, -4));
  assert.equal((await short.response).status, 500);
  assert.equal(handled(), 1);
  assert.deepEqual(await readdir(destination), saved);
});

test('multipart writes progressively and removes an interrupted disk file before settling', { timeout: 5_000 }, async t => {
  const { start, destination, settled, handled } = await fixture(t, 512 * 1024);
  const { client, response } = start();
  client.write(part());
  client.write(Buffer.alloc(64 * 1024, 42));
  await eventually(async () => {
    const names = await readdir(destination).catch(() => []);
    if (names[0] && (await stat(join(destination, names[0]))).size > 0) return true;
  });
  assert.equal(handled(), 0);
  client.destroy();
  await assert.rejects(response);
  await eventually(async () => settled() === 1 ? true : undefined);
  assert.deepEqual(await readdir(destination), []);
});

test('storage failure leaves a pre-existing filesystem entry untouched', { timeout: 5_000 }, async t => {
  const { start, handled, destination } = await fixture(t, 1024, true);
  const { client, response } = start();
  client.end(part() + 'payload' + end);
  assert.equal((await response).status, 500);
  assert.equal(handled(), 0);
  assert.ok((await stat(destination)).isFile());
});


test('a mid-write failure removes every file owned by the upload', { timeout: 5_000 }, async t => {
  const { start, destination, handled } = await fixture(t, 512 * 1024);
  const write = WriteStream.prototype._write;
  let failed = false;
  t.mock.method(WriteStream.prototype, '_write', function (this: WriteStream, ...args: Parameters<typeof write>) {
    if (this.bytesWritten > 1024 && !failed) {
      failed = true;
      args[2](Object.assign(new Error('fixture disk filled during upload'), { code: 'ENOSPC' }));
    } else {
      write.apply(this, args);
    }
  });
  const { client, response } = start();
  client.write(part() + 'first file\r\n');
  client.write(part() + 'x'.repeat(64 * 1024));
  await eventually(async () => {
    const files = await readdir(destination).catch(() => []);
    if (files.length !== 2) return;
    const sizes = await Promise.all(files.map(file => stat(join(destination, file))));
    if (sizes.some(file => file.size > 1024)) return true;
  });
  client.end('x'.repeat(32 * 1024) + end);
  assert.equal((await response).status, 500);
  assert.equal(failed, true);
  assert.equal(handled(), 0);
  assert.deepEqual(await readdir(destination), []);
});


test('rejected multipart removes completed files while Multer drains the remaining request', { timeout: 5_000 }, async t => {
  const { start, destination, handled } = await fixture(t, 512 * 1024);
  const { client, response } = start();
  client.write(part() + 'x'.repeat(64 * 1024));
  await eventually(async () => {
    const [filename] = await readdir(destination).catch(() => []);
    if (filename && (await stat(join(destination, filename))).size > 0) return true;
  });
  client.write('\r\n' + part('img', 'text/plain') + 'rejected');
  await eventually(async () => (await readdir(destination)).length === 0 ? true : undefined);
  client.end(end);
  assert.deepEqual(await response, { status: 400, body: JSON.stringify({ msg: IMAGE_TYPE_LIMIT_MESSAGE, code: 400 }) });
  assert.equal(handled(), 0);
});
