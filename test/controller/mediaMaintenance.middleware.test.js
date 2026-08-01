const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const config = require('@/app/config');
const mediaMutationMaintenance = require('@/middleware/mediaMaintenance.middleware');

test('media maintenance gate allows mutations when the pause flag is false', async () => {
  const original = config.MEDIA_MUTATIONS_PAUSED;
  config.MEDIA_MUTATIONS_PAUSED = 'false';
  let nextCalls = 0;

  try {
    const ctx = {};
    await mediaMutationMaintenance(ctx, async () => {
      nextCalls += 1;
    });

    assert.equal(nextCalls, 1);
    assert.equal(ctx.status, undefined);
    assert.equal(ctx.body, undefined);
  } finally {
    config.MEDIA_MUTATIONS_PAUSED = original;
  }
});

test('media maintenance gate returns 503 before mutation handlers when paused', async () => {
  const original = config.MEDIA_MUTATIONS_PAUSED;
  config.MEDIA_MUTATIONS_PAUSED = 'true';
  let nextCalls = 0;

  try {
    const ctx = {};
    await mediaMutationMaintenance(ctx, async () => {
      nextCalls += 1;
    });

    assert.equal(nextCalls, 0);
    assert.equal(ctx.status, 503);
    assert.deepEqual(ctx.body, {
      code: 503,
      msg: '媒体上传和文章发布正在进行短时维护，请稍后重试',
    });
  } finally {
    config.MEDIA_MUTATIONS_PAUSED = original;
  }
});

test('media maintenance gate is attached only to routes that change the published media set', () => {
  const expected = new Set([
    'DELETE /article/:articleId',
    'DELETE /img',
    'DELETE /video',
    'POST /article',
    'POST /img',
    'POST /img/:articleId',
    'POST /video',
    'POST /video/:articleId',
    'PUT /article/:articleId',
  ]);
  const actual = [];

  for (const layer of ['article', 'image', 'video', 'draft'].flatMap((name) => require(`@/router/${name}.router`).stack)) {
    for (const method of layer.methods.filter((candidate) => candidate !== 'HEAD')) {
      const signature = `${method} ${layer.path}`;
      const hasMaintenanceGate = layer.stack.includes(mediaMutationMaintenance);

      if (expected.has(signature)) {
        assert.equal(layer.stack[0], mediaMutationMaintenance, `${signature} must run the maintenance gate first`);
        actual.push(signature);
      } else {
        assert.equal(hasMaintenanceGate, false, `${signature} must remain available during media maintenance`);
      }
    }
  }

  assert.deepEqual(actual.sort(), [...expected]);
});
