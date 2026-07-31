const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('module-alias/register');

let createPublishedVideoPromotionService;
try {
  ({ createPublishedVideoPromotionService } = require('@/service/publishedVideoPromotion.service'));
} catch {
  createPublishedVideoPromotionService = undefined;
}

async function createVideoFixture(t) {
  const videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-published-video-'));
  await fs.writeFile(path.join(videoRoot, 'clip.mp4'), 'temporary video');
  await fs.writeFile(path.join(videoRoot, 'clip-poster.jpg'), 'temporary poster');
  t.after(() => fs.rm(videoRoot, { recursive: true, force: true }));
  return videoRoot;
}

function completedVideo(overrides = {}) {
  return {
    id: 640,
    filename: 'clip.mp4',
    mimetype: 'video/mp4',
    poster: 'clip-poster.jpg',
    transcode_status: 'completed',
    ...overrides,
  };
}

test('published video promotion: processing videos never write video or poster to R2', async (t) => {
  assert.equal(typeof createPublishedVideoPromotionService, 'function');
  const videoRoot = await createVideoFixture(t);
  const calls = [];
  const service = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote(payload) {
        calls.push(payload);
      },
    },
  });

  const result = await service.promotePublishedVideos({
    articleId: 88,
    videos: [completedVideo({ transcode_status: 'processing' })],
  });

  assert.equal(result.attempted, 0);
  assert.equal(result.skippedNotCompleted, 1);
  assert.deepEqual(calls, []);
});

test('published video promotion: completed published videos promote only the final video and poster', async (t) => {
  assert.equal(typeof createPublishedVideoPromotionService, 'function');
  const videoRoot = await createVideoFixture(t);
  const calls = [];
  const service = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote(payload) {
        calls.push(payload);
        return { skipped: false };
      },
    },
  });

  const result = await service.promotePublishedVideos({
    articleId: 88,
    videos: [completedVideo()],
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.ready, 2);
  assert.equal(result.completed, 1);
  assert.deepEqual(
    calls.map(({ articleId, fileId, variant, localPath, contentType }) => ({ articleId, fileId, variant, localPath, contentType })),
    [
      {
        articleId: 88,
        fileId: 640,
        variant: 'video',
        localPath: path.join(videoRoot, 'clip.mp4'),
        contentType: 'video/mp4',
      },
      {
        articleId: 88,
        fileId: 640,
        variant: 'poster',
        localPath: path.join(videoRoot, 'clip-poster.jpg'),
        contentType: 'image/jpeg',
      },
    ],
  );
});

test('published video promotion: a missing poster prevents both variant uploads', async (t) => {
  const videoRoot = await createVideoFixture(t);
  await fs.unlink(path.join(videoRoot, 'clip-poster.jpg'));
  const calls = [];
  const service = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote(payload) {
        calls.push(payload);
      },
    },
  });

  const result = await service.promotePublishedVideos({ articleId: 88, videos: [completedVideo()] });

  assert.equal(result.attempted, 0);
  assert.equal(result.skippedMissingAssets, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures[0].missing, ['poster']);
  assert.deepEqual(calls, []);
});

test('published video promotion: completed status without a database poster is incomplete, not an upload attempt', async (t) => {
  const videoRoot = await createVideoFixture(t);
  const calls = [];
  const service = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote(payload) {
        calls.push(payload);
      },
    },
  });

  const result = await service.promotePublishedVideos({
    articleId: 88,
    videos: [completedVideo({ poster: null })],
  });

  assert.equal(result.attempted, 0);
  assert.equal(result.skippedMissingAssets, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures[0].missing, ['poster']);
  assert.deepEqual(calls, []);
});

test('published video promotion: local mode and the emergency pause never attempt R2 writes', async (t) => {
  const videoRoot = await createVideoFixture(t);
  const promote = async () => {
    throw new Error('R2 promotion must not run');
  };
  const localService = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'local',
    mediaPromotionService: { promote },
  });
  const pausedService = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    writePaused: true,
    mediaPromotionService: { promote },
  });

  assert.deepEqual(await localService.promotePublishedVideos({ articleId: 88, videos: [completedVideo()] }), {
    enabled: false,
    reason: 'write_mode_local',
    examined: 0,
    eligible: 0,
    attempted: 0,
    ready: 0,
    idempotent: 0,
    inProgress: 0,
    failed: 0,
    completed: 0,
    skippedNotCompleted: 0,
    skippedMissingAssets: 0,
    failures: [],
  });
  assert.equal((await pausedService.promotePublishedVideos({ articleId: 88, videos: [completedVideo()] })).reason, 'r2_write_paused');
});

test('published video promotion: idempotent retries count both ready variants as one completed pair', async (t) => {
  const videoRoot = await createVideoFixture(t);
  const service = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote() {
        return { skipped: true };
      },
    },
  });

  const result = await service.promotePublishedVideos({ articleId: 88, videos: [completedVideo()] });

  assert.equal(result.ready, 2);
  assert.equal(result.idempotent, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
});

test('published video promotion: poster failure is reported and never counted as complete', async (t) => {
  const videoRoot = await createVideoFixture(t);
  const calls = [];
  const service = createPublishedVideoPromotionService({
    videoRoot,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote(payload) {
        calls.push(payload.variant);
        if (payload.variant === 'poster') throw new Error('poster upload failed');
        return { skipped: false };
      },
    },
  });

  const result = await service.promotePublishedVideos({ articleId: 88, videos: [completedVideo()] });

  assert.deepEqual(calls, ['video', 'poster']);
  assert.equal(result.ready, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.deepEqual(
    result.failures.map(({ variant, message }) => ({ variant, message })),
    [{ variant: 'poster', message: 'poster upload failed' }],
  );
});
