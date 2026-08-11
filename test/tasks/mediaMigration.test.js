const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { migrateMediaToR2 } = require('@/tasks/migrateMediaToR2');

function candidate(fileId, variant = 'original', sizeBytes = 10) {
  return {
    articleId: 7,
    fileId,
    fileType: 'image',
    variant,
    localPath: `/srv/coderx/public/img/${fileId}-${variant}.jpg`,
    filename: `${fileId}-${variant}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes,
  };
}

function catalogFixture(candidates, extras = {}) {
  const calls = [];
  return {
    calls,
    catalog: {
      async listPublishedFiles(options) {
        calls.push(options);
        return Array.from(new Map(candidates.map((item) => [item.fileId, { id: item.fileId, articleId: item.articleId }])).values());
      },
      async discoverVariants() {
        return {
          candidates,
          missingAssets: extras.missingAssets || [],
          optionalMissingAssets: [],
          invalidRows: extras.invalidRows || [],
        };
      },
    },
  };
}

test('historical migration dry-run reports candidates and performs zero promotions', async () => {
  const candidates = [candidate(11, 'original', 10), candidate(11, 'small', 4)];
  const { catalog, calls } = catalogFixture(candidates);
  let promoted = false;
  const result = await migrateMediaToR2({
    catalog,
    mediaPromotionService: {
      async promote() {
        promoted = true;
      },
    },
    dryRun: true,
    articleId: 7,
    afterFileId: 10,
    limit: 5,
    concurrency: 1,
    writeMode: 'r2_on_publish',
    writePaused: false,
  });

  assert.equal(promoted, false);
  assert.deepEqual(calls, [{ articleId: 7, afterFileId: 10, limit: 5 }]);
  assert.equal(result.dryRun, true);
  assert.equal(result.candidateObjects, 2);
  assert.equal(result.candidateBytes, 14);
  assert.equal(result.attempted, 0);
  assert.equal(result.retainedLocal, 2);
  assert.equal(result.nextAfterFileId, 11);
});

test('historical migration respects local and paused switches without calling promotion', async () => {
  const { catalog } = catalogFixture([candidate(11)]);
  let calls = 0;
  const mediaPromotionService = {
    async promote() {
      calls += 1;
    },
  };

  const local = await migrateMediaToR2({ catalog, mediaPromotionService, dryRun: false, writeMode: 'local', writePaused: false });
  const paused = await migrateMediaToR2({ catalog, mediaPromotionService, dryRun: false, writeMode: 'r2_on_publish', writePaused: true });

  assert.equal(calls, 0);
  assert.equal(local.reason, 'write_mode_local');
  assert.equal(paused.reason, 'r2_write_paused');
});

test('historical migration bounds concurrency and counts ready, idempotent and in-progress results', async () => {
  const candidates = [candidate(11), candidate(12), candidate(13), candidate(14)];
  const { catalog } = catalogFixture(candidates);
  let active = 0;
  let maxActive = 0;
  const mediaPromotionService = {
    async promote(payload) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (payload.fileId === 12) return { skipped: true, retainedLocal: true };
      if (payload.fileId === 13) return { skipped: true, inProgress: true, retainedLocal: true };
      return { skipped: false, retainedLocal: true };
    },
  };

  const result = await migrateMediaToR2({
    catalog,
    mediaPromotionService,
    dryRun: false,
    concurrency: 2,
    writeMode: 'r2_on_publish',
    writePaused: false,
  });

  assert.equal(maxActive, 2);
  assert.equal(result.attempted, 4);
  assert.equal(result.ready, 3);
  assert.equal(result.idempotent, 1);
  assert.equal(result.inProgress, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retainedLocal, 4);
});

test('historical migration continues after partial failures and reports catalog gaps', async () => {
  const candidates = [candidate(11), candidate(12)];
  const { catalog } = catalogFixture(candidates, {
    missingAssets: [{ fileId: 13, articleId: 7, variant: 'original' }],
  });
  const mediaPromotionService = {
    async promote(payload) {
      if (payload.fileId === 11) {
        const error = new Error('R2 unavailable');
        error.code = 'R2_UNAVAILABLE';
        throw error;
      }
      return { retainedLocal: true };
    },
  };

  const result = await migrateMediaToR2({
    catalog,
    mediaPromotionService,
    dryRun: false,
    concurrency: 3,
    writeMode: 'r2_on_publish',
    writePaused: false,
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.ready, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].code, 'R2_UNAVAILABLE');
  assert.deepEqual(result.missingAssets, [{ fileId: 13, articleId: 7, variant: 'original' }]);
});

test('historical migration rejects unsafe concurrency before discovering media', async () => {
  const { catalog } = catalogFixture([]);
  await assert.rejects(migrateMediaToR2({ catalog, mediaPromotionService: { async promote() {} }, concurrency: 11 }), /concurrency/i);
});

test('historical migration omits article scope for neutral Flow candidates and preserves legacy article scope', async () => {
  const articleCandidate = candidate(21);
  const flowCandidate = { ...candidate(22), articleId: null, flowId: 91 };
  const { catalog } = catalogFixture([articleCandidate, flowCandidate]);
  const promoted = [];

  await migrateMediaToR2({
    catalog,
    mediaPromotionService: {
      async promote(payload) {
        promoted.push(payload);
        return { retainedLocal: true };
      },
    },
    dryRun: false,
    concurrency: 1,
    writeMode: 'r2_on_publish',
    writePaused: false,
  });

  assert.equal(promoted[0].articleId, 7);
  assert.equal(Object.hasOwn(promoted[1], 'articleId'), false);
  assert.equal(Object.hasOwn(promoted[1], 'flowId'), false);
});
