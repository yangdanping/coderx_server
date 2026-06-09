const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const { baseURL } = require('../../src/constants/urls');
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

test('saveVideoInfo: keeps poster null while the background pipeline is processing', async () => {
  const calls = [];
  const videoService = {
    async addVideo(userId, filename, mimetype, size) {
      calls.push({ method: 'addVideo', userId, filename, mimetype, size });
      return { insertId: 466 };
    },
    async updateTranscodeStatus(videoId, status) {
      calls.push({ method: 'updateTranscodeStatus', videoId, status });
    },
  };

  const controller = loadControllerWithMocks({ videoService });
  controller.processVideoAsset = (...args) => {
    calls.push({ method: 'processVideoAsset', args });
  };
  const ctx = {
    user: { id: 1 },
    file: {
      filename: 'demo.mp4',
      mimetype: 'video/mp4',
      size: 1024,
      path: __filename,
    },
  };

  await controller.saveVideoInfo(ctx, async () => {});

  assert.equal(ctx.body.code, 0);
  assert.deepEqual(ctx.body.data, {
    id: 466,
    url: `${baseURL}/article/video/demo.mp4`,
    poster: null,
    filename: 'demo.mp4',
    transcodeStatus: 'processing',
  });
  assert.deepEqual(calls.slice(0, 2), [
    {
      method: 'addVideo',
      userId: 1,
      filename: 'demo.mp4',
      mimetype: 'video/mp4',
      size: 1024,
    },
    {
      method: 'updateTranscodeStatus',
      videoId: 466,
      status: 'processing',
    },
  ]);
  assert.equal(calls[2]?.method, 'processVideoAsset');
});

test('getVideoInfo: converts a poster filename into a public article video URL', async () => {
  const videoService = {
    async getVideoById(videoId) {
      assert.equal(videoId, '464');
      return {
        id: 464,
        filename: 'demo.mp4',
        poster: 'demo-poster.jpg',
        transcode_status: 'completed',
      };
    },
  };

  const controller = loadControllerWithMocks({ videoService });
  const ctx = {
    params: {
      videoId: '464',
    },
  };

  await controller.getVideoInfo(ctx, async () => {});

  assert.equal(ctx.body.code, 0);
  assert.equal(ctx.body.data.poster, `${baseURL}/article/video/demo-poster.jpg`);
  assert.equal(ctx.body.data.transcode_status, 'completed');
});

test('getVideoInfo: keeps poster null while video processing has not produced one', async () => {
  const videoService = {
    async getVideoById() {
      return {
        id: 465,
        filename: 'processing.mp4',
        poster: null,
        transcode_status: 'processing',
      };
    },
  };

  const controller = loadControllerWithMocks({ videoService });
  const ctx = {
    params: {
      videoId: '465',
    },
  };

  await controller.getVideoInfo(ctx, async () => {});

  assert.equal(ctx.body.code, 0);
  assert.equal(ctx.body.data.poster, null);
});
