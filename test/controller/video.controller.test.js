const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('module-alias/register');

const { baseURL } = require('../../src/constants/urls');
const controllerPath = path.resolve(__dirname, '../../src/controller/video.controller.js');
const videoServicePath = path.resolve(__dirname, '../../src/service/video.service.js');
const mediaRuntimePath = path.resolve(__dirname, '../../src/service/mediaRuntime.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithMocks({ videoService, mediaRuntime = null }) {
  delete require.cache[controllerPath];
  delete require.cache[videoServicePath];
  delete require.cache[mediaRuntimePath];

  injectCache(videoServicePath, videoService);
  injectCache(
    mediaRuntimePath,
    mediaRuntime || {
      async promotePublishedVideos() {
        return { attempted: 0, ready: 0, inProgress: 0, failed: 0, completed: 0 };
      },
      async resolveVideoUrl() {
        return null;
      },
      async resolveVideoPosterUrl() {
        return null;
      },
    },
  );

  return require(controllerPath);
}

test('updateVideoArticle: empty videoIds array clears article video links instead of failing validation', async () => {
  const calls = [];
  const videoService = {
    async updateVideoArticle(articleId, videoIds, userId) {
      calls.push({ method: 'updateVideoArticle', articleId, videoIds, userId });
      return { success: true, affectedRows: 0, deletedCount: 1 };
    },
    async filterValidVideoIds(videoIds) {
      calls.push({ method: 'filterValidVideoIds', videoIds });
      return videoIds;
    },
  };

  const controller = loadControllerWithMocks({ videoService });
  const ctx = {
    user: { id: 7 },
    params: { articleId: '21' },
    request: {
      body: {
        videoIds: [],
      },
    },
  };

  await controller.updateVideoArticle(ctx, async () => {});

  assert.deepEqual(calls, [{ method: 'updateVideoArticle', articleId: '21', videoIds: [], userId: 7 }]);
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
    user: { id: 7 },
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

test('getVideoInfo: returns shared CDN-preferred video and poster URLs', async () => {
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

  const controller = loadControllerWithMocks({
    videoService,
    mediaRuntime: {
      async resolveVideoUrl(videoId) {
        assert.equal(videoId, 464);
        return 'https://media.example/articles/88/videos/464/hash-video.mp4';
      },
      async resolveVideoPosterUrl(videoId) {
        assert.equal(videoId, 464);
        return 'https://media.example/articles/88/videos/464/hash-poster.jpg';
      },
    },
  });
  const ctx = {
    params: {
      videoId: '464',
    },
  };

  await controller.getVideoInfo(ctx, async () => {});

  assert.equal(ctx.body.code, 0);
  assert.equal(ctx.body.data.url, 'https://media.example/articles/88/videos/464/hash-video.mp4');
  assert.equal(ctx.body.data.poster, 'https://media.example/articles/88/videos/464/hash-poster.jpg');
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

test('processVideoAsset: completed processing delegates to a lock-and-revalidate promotion path', async () => {
  const calls = [];
  const controller = loadControllerWithMocks({
    videoService: {
      async updateTranscodeStatus(videoId, status) {
        calls.push({ type: 'status', videoId, status });
      },
      async updateVideoMetadata(videoId, metadata) {
        calls.push({ type: 'metadata', videoId, metadata });
      },
      async updateVideoPoster(videoId, poster) {
        calls.push({ type: 'poster', videoId, poster });
      },
      async promotePublishedVideoIds(videoIds) {
        calls.push({ type: 'promote', videoIds });
        return { attempted: 2, ready: 2, inProgress: 0, failed: 0, completed: 1 };
      },
    },
  });
  controller.probeVideo = async () => ({ duration: 2, width: 320, height: 240, bitrate: 100, format: 'mp4' });
  controller.runFfmpegScreenshot = async () => '/tmp/clip-poster.jpg';

  await controller.processVideoAsset('/tmp/clip.mp4', 'clip-poster.jpg', '/tmp', 466);

  const completedIndex = calls.findIndex((call) => call.type === 'status' && call.status === 'completed');
  const promoteIndex = calls.findIndex((call) => call.type === 'promote');
  assert.ok(completedIndex >= 0);
  assert.ok(promoteIndex > completedIndex);
  assert.deepEqual(calls[promoteIndex].videoIds, [466]);
});

test('processVideoAsset: completed draft video remains local when no article is linked', async () => {
  const calls = [];
  const controller = loadControllerWithMocks({
    videoService: {
      async updateTranscodeStatus() {},
      async updateVideoMetadata() {},
      async updateVideoPoster() {},
      async promotePublishedVideoIds(videoIds) {
        calls.push(videoIds);
        return { attempted: 0, ready: 0, inProgress: 0, failed: 0, completed: 0 };
      },
    },
  });
  controller.probeVideo = async () => ({ duration: 2 });
  controller.runFfmpegScreenshot = async () => '/tmp/draft-poster.jpg';

  await controller.processVideoAsset('/tmp/draft.mp4', 'draft-poster.jpg', '/tmp', 467);

  assert.deepEqual(calls, [[467]]);
});

test('deleteVideo: relies on the durable service cleanup result instead of unlinking after commit', async () => {
  const calls = [];
  const originalExistsSync = fs.existsSync;
  const originalUnlinkSync = fs.unlinkSync;
  const controller = loadControllerWithMocks({
    videoService: {
      async deleteVideos(videoIds, userId) {
        calls.push({ type: 'deleteStoredState', videoIds, userId });
        return {
          result: { affectedRows: 1 },
          videosToDelete: [{ id: 71, filename: 'clip.mp4', poster: 'clip-poster.jpg' }],
          localCleanup: { examined: 2, deleted: 2, missing: 0, failed: 0, pendingIds: [] },
        };
      },
    },
  });
  fs.existsSync = () => true;
  fs.unlinkSync = (filePath) => {
    calls.push({ type: 'unlink', filePath });
  };

  const ctx = {
    user: { id: 5 },
    request: { body: { videoIds: [71] } },
  };
  try {
    await controller.deleteVideo(ctx, async () => {});
  } finally {
    fs.existsSync = originalExistsSync;
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.deepEqual(calls, [{ type: 'deleteStoredState', videoIds: [71], userId: 5 }]);
  assert.equal(ctx.body.code, 0);
});

test('deleteVideo: pending promotion failure leaves local files untouched', async () => {
  const calls = [];
  const originalUnlinkSync = fs.unlinkSync;
  const controller = loadControllerWithMocks({
    videoService: {
      async deleteVideos() {
        calls.push('deleteStoredState');
        throw new Error('R2 upload is still pending');
      },
    },
  });
  fs.unlinkSync = () => {
    calls.push('unlink');
  };

  const ctx = {
    user: { id: 5 },
    request: { body: { videoIds: [71] } },
  };
  try {
    await assert.rejects(
      controller.deleteVideo(ctx, async () => {}),
      /still pending/,
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.deepEqual(calls, ['deleteStoredState']);
});
