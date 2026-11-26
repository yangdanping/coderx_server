import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpApp } from '../../src/http/app.js';

for (const [field, msg] of [
  ['video', '视频大小不能超过 20MB'],
  ['img', '图片大小不能超过 20MB'],
] as const) {
  test(`upload size errors preserve the 20MB limit message for ${field}`, async () => {
    const app = createHttpApp({
      buildId: 'upload-errors', checkReady: async () => true,
      registerRoutes(app) {
        app.post('/upload', () => {
          throw Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE', field });
        });
      },
    });
    const response = await app.request('/upload', { method: 'POST' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 400, msg });
  });
}
