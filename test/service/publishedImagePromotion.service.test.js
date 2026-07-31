const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('module-alias/register');

let createPublishedImagePromotionService;
try {
  ({ createPublishedImagePromotionService } = require('@/service/publishedImagePromotion.service'));
} catch {
  createPublishedImagePromotionService = undefined;
}

async function createImageFixture(t, { withSmall = true } = {}) {
  const imageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-stage3-images-'));
  await fs.writeFile(path.join(imageRoot, 'cover.jpg'), 'original');
  if (withSmall) {
    await fs.writeFile(path.join(imageRoot, 'cover-small.jpg'), 'small');
  }
  t.after(() => fs.rm(imageRoot, { recursive: true, force: true }));
  return imageRoot;
}

function imageRow() {
  return {
    id: 41,
    filename: 'cover.jpg',
    mimetype: 'image/jpeg',
    size: 8,
    file_type: 'image',
  };
}

test('published image promotion: r2_on_publish promotes original and an existing small variant', async (t) => {
  assert.equal(typeof createPublishedImagePromotionService, 'function');
  const imageRoot = await createImageFixture(t);
  const calls = [];
  const service = createPublishedImagePromotionService({
    imageRoot,
    writeMode: 'r2_on_publish',
    writePaused: false,
    mediaPromotionService: {
      async promote(payload) {
        calls.push(payload);
        return { key: `${payload.fileId}/${payload.variant}`, skipped: false, retainedLocal: true };
      },
    },
  });

  const result = await service.promotePublishedImages({
    articleId: 9,
    images: [imageRow()],
  });

  assert.deepEqual(
    calls.map(({ articleId, fileId, variant, localPath, contentType }) => ({
      articleId,
      fileId,
      variant,
      localPath: path.basename(localPath),
      contentType,
    })),
    [
      {
        articleId: 9,
        fileId: 41,
        variant: 'original',
        localPath: 'cover.jpg',
        contentType: 'image/jpeg',
      },
      {
        articleId: 9,
        fileId: 41,
        variant: 'small',
        localPath: 'cover-small.jpg',
        contentType: 'image/jpeg',
      },
    ],
  );
  assert.deepEqual(result, {
    enabled: true,
    reason: null,
    attempted: 2,
    ready: 2,
    idempotent: 0,
    inProgress: 0,
    failed: 0,
    failures: [],
  });
});

test('published image promotion: a missing small variant is skipped without inventing a file', async (t) => {
  assert.equal(typeof createPublishedImagePromotionService, 'function');
  const imageRoot = await createImageFixture(t, { withSmall: false });
  const variants = [];
  const service = createPublishedImagePromotionService({
    imageRoot,
    writeMode: 'r2_on_publish',
    writePaused: false,
    mediaPromotionService: {
      async promote(payload) {
        variants.push(payload.variant);
        return { key: payload.variant, skipped: false, retainedLocal: true };
      },
    },
  });

  const result = await service.promotePublishedImages({
    articleId: 9,
    images: [imageRow()],
  });

  assert.deepEqual(variants, ['original']);
  assert.equal(result.attempted, 1);
  assert.equal(result.ready, 1);
});

test('published image promotion: local mode and the emergency pause never attempt R2 writes', async (t) => {
  assert.equal(typeof createPublishedImagePromotionService, 'function');
  const imageRoot = await createImageFixture(t);
  const promote = async () => {
    throw new Error('R2 promotion must not run');
  };
  const localService = createPublishedImagePromotionService({
    imageRoot,
    writeMode: 'local',
    writePaused: false,
    mediaPromotionService: { promote },
  });
  const pausedService = createPublishedImagePromotionService({
    imageRoot,
    writeMode: 'r2_on_publish',
    writePaused: true,
    mediaPromotionService: { promote },
  });

  assert.deepEqual(await localService.promotePublishedImages({ articleId: 9, images: [imageRow()] }), {
    enabled: false,
    reason: 'write_mode_local',
    attempted: 0,
    ready: 0,
    idempotent: 0,
    inProgress: 0,
    failed: 0,
    failures: [],
  });
  assert.deepEqual(await pausedService.promotePublishedImages({ articleId: 9, images: [imageRow()] }), {
    enabled: false,
    reason: 'r2_write_paused',
    attempted: 0,
    ready: 0,
    idempotent: 0,
    inProgress: 0,
    failed: 0,
    failures: [],
  });
});

test('published image promotion: per-variant failures are reported without stopping other variants', async (t) => {
  assert.equal(typeof createPublishedImagePromotionService, 'function');
  const imageRoot = await createImageFixture(t);
  const service = createPublishedImagePromotionService({
    imageRoot,
    writeMode: 'r2_on_publish',
    writePaused: false,
    mediaPromotionService: {
      async promote(payload) {
        if (payload.variant === 'original') {
          const error = new Error('R2 unavailable');
          error.code = 'R2_UNAVAILABLE';
          throw error;
        }
        return { key: payload.variant, skipped: true, inProgress: false, retainedLocal: true };
      },
    },
  });

  const result = await service.promotePublishedImages({
    articleId: 9,
    images: [imageRow()],
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.ready, 1);
  assert.equal(result.idempotent, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [
    {
      fileId: 41,
      variant: 'original',
      code: 'R2_UNAVAILABLE',
      message: 'R2 unavailable',
    },
  ]);
});
