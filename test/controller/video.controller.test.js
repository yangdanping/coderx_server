const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/video.controller.js');
const videoServicePath = path.resolve(__dirname, '../../src/service/video.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithMocks({ videoService }) {
  delete require.cache[controllerPath];
  delete require.cache[videoServicePath];

  injectCache(videoServicePath, videoService);

  return require(controllerPath);
}

test('updateVideoArticle: empty videoIds array clears article video links instead of failing validation', async () => {
  const calls = [];
  const videoService = {
    async updateVideoArticle(articleId, videoIds) {
      calls.push({ method: 'updateVideoArticle', articleId, videoIds });
      return { success: true, affectedRows: 0, deletedCount: 1 };
    },
    async filterValidVideoIds(videoIds) {
      calls.push({ method: 'filterValidVideoIds', videoIds });
      return videoIds;
    },
  };

  const controller = loadControllerWithMocks({ videoService });
  const ctx = {
    params: { articleId: '21' },
    request: {
      body: {
        videoIds: [],
      },
    },
  };

  await controller.updateVideoArticle(ctx, async () => {});

  assert.deepEqual(calls, [{ method: 'updateVideoArticle', articleId: '21', videoIds: [] }]);
  assert.equal(ctx.body.code, 0);
  assert.deepEqual(ctx.body.data, {
    success: true,
    affectedRows: 0,
    deletedCount: 1,
  });
});

test('updateVideoArticle: rejects requests that exceed the article video limit with unified copy', async () => {
  const calls = [];
  const videoService = {
    async updateVideoArticle(articleId, videoIds) {
      calls.push({ method: 'updateVideoArticle', articleId, videoIds });
      return { success: true };
    },
    async filterValidVideoIds(videoIds) {
      calls.push({ method: 'filterValidVideoIds', videoIds });
      return videoIds;
    },
  };

  const controller = loadControllerWithMocks({ videoService });
  const ctx = {
    params: { articleId: '21' },
    request: {
      body: {
        videoIds: [1, 2, 3],
      },
    },
  };

  await controller.updateVideoArticle(ctx, async () => {});

  assert.deepEqual(calls, []);
  assert.equal(ctx.body.code, -1);
  assert.equal(ctx.body.msg, '每篇文章最多只能上传 2 个视频');
});
