const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const middlewarePath = path.resolve(__dirname, '../../src/middleware/error.middleware.js');

function loadErrorMiddleware() {
  delete require.cache[middlewarePath];
  return require(middlewarePath);
}

test('errorMiddleware: maps video upload size errors to a user-facing 20MB message', async () => {
  const errorMiddleware = loadErrorMiddleware();
  const ctx = {
    method: 'POST',
    url: '/video',
    path: '/video',
    ip: '127.0.0.1',
  };

  await errorMiddleware(ctx, async () => {
    const error = new Error('File too large');
    error.code = 'LIMIT_FILE_SIZE';
    error.field = 'video';
    throw error;
  });

  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.code, 400);
  assert.equal(ctx.body.msg, '视频大小不能超过 20MB');
});

test('errorMiddleware: maps image upload size errors to a user-facing 20MB message', async () => {
  const errorMiddleware = loadErrorMiddleware();
  const ctx = {
    method: 'POST',
    url: '/img',
    path: '/img',
    ip: '127.0.0.1',
  };

  await errorMiddleware(ctx, async () => {
    const error = new Error('File too large');
    error.code = 'LIMIT_FILE_SIZE';
    error.field = 'img';
    throw error;
  });

  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.code, 400);
  assert.equal(ctx.body.msg, '图片大小不能超过 20MB');
});
