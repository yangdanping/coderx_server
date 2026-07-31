const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

process.env.NODE_ENV = 'development';

test('media runtime exposes video promotion and URL resolution behind local-safe defaults', async () => {
  const mediaRuntime = require('@/service/mediaRuntime.service');

  assert.equal(typeof mediaRuntime.promotePublishedVideos, 'function');
  assert.equal(typeof mediaRuntime.resolveVideoUrl, 'function');
  assert.equal(typeof mediaRuntime.resolveVideoPosterUrl, 'function');

  const result = await mediaRuntime.promotePublishedVideos({ articleId: 88, videos: [] });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'write_mode_local');
  assert.equal(result.attempted, 0);
});
