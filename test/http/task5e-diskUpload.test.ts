import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { IMAGE_TYPE_LIMIT_MESSAGE, IMAGE_SIZE_LIMIT_MESSAGE, IMAGE_BATCH_COUNT_LIMIT_MESSAGE } from '../../src/constants/upload.js';
import { createHttpApp } from '../../src/http/app.js';
import { CompatibilityRouter } from '../../src/http/compatibility.router.js';
import { createDiskUpload } from '../../src/middleware/diskUpload.middleware.js';
import { legacyJson } from '../../src/http/legacyResponse.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'coderx-disk-upload-'));
  const uploadRoot = join(root, 'img');
  const upload = createDiskUpload({
    root: uploadRoot, field: 'img', maxCount: 2, maxBytes: 8,
    mimePrefix: 'image/', mimeError: IMAGE_TYPE_LIMIT_MESSAGE,
  });
  const app = createHttpApp({
    buildId: 'disk-upload-test', checkReady: async () => false,
    registerRoutes(app) {
      if (app.router instanceof CompatibilityRouter) app.router.preserveLegacyLiteralPath('/img');
      app.post('/img', upload, async c => {
        const files = c.get('diskUploads') ?? [];
        const data = await Promise.all(files.map(async file => ({
          field: file.fieldname,
          name: file.filename,
          size: file.size,
          bytes: await readFile(file.path, 'utf8'),
        })));
        return legacyJson(c, { data });
      });
    },
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const send = (path: string, fileParts: readonly (readonly [string, string, string?])[]) => {
    const form = new FormData();
    for (const [field, bytes, type = 'image/png'] of fileParts) {
      form.append(field, new Blob([bytes], { type }), 'sample.png');
    }
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(5000),
    });
  };
  return { send, uploadRoot };
}

test('disk multipart preserves order, all same-name fields and per-file limits under the Node adapter', async t => {
  const { send, uploadRoot } = await fixture(t);
  const response = await send('/IMG/', [['img', '12345678'], ['img', 'second']]);
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: { field: string; name: string; size: number; bytes: string }[] };
  assert.deepEqual(data.map(({ field, name, size, bytes }) => [field, extname(name), size, bytes]), [
    ['img', '.png', 8, '12345678'], ['img', '.png', 6, 'second'],
  ]);
  assert.equal(new Set(data.map(item => item.name)).size, 2);
  assert.deepEqual((await readdir(uploadRoot)).sort(), data.map(item => item.name).sort());
});

test('rejected multipart requests remove parsed files and preserve Koa error envelopes', async t => {
  const { send, uploadRoot } = await fixture(t);
  for (const [path, files, status, message] of [
    ['/img', [['img', 'ok'], ['img', '123456789']], 400, IMAGE_SIZE_LIMIT_MESSAGE],
    ['/img', [['img', 'ok'], ['img', 'also ok'], ['img', 'too many']], 400, IMAGE_BATCH_COUNT_LIMIT_MESSAGE],
    ['/img', [['img', 'ok'], ['img', 'wrong type', 'text/plain']], 400, IMAGE_TYPE_LIMIT_MESSAGE],
    ['/img', [['other', 'wrong field']], 400, IMAGE_BATCH_COUNT_LIMIT_MESSAGE],
    ['/IMG/', [['other', 'wrong field']], 500, '服务器内部错误'],
  ] as const) {
    const response = await send(path, files);
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { msg: message, code: status });
    assert.deepEqual(await readdir(uploadRoot), []);
  }
});
