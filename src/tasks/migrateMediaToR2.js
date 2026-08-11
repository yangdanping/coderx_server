const { MEDIA_WRITE_MODE } = require('@/constants/mediaStorage');

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

function normalizeConcurrency(value = DEFAULT_CONCURRENCY) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_CONCURRENCY) {
    throw new TypeError(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  return parsed;
}

function isPaused(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

async function runBounded(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function failureFor(candidate, error) {
  return {
    fileId: candidate.fileId,
    variant: candidate.variant,
    code: typeof error?.code === 'string' ? error.code : 'MEDIA_MIGRATION_FAILED',
    message: String(error?.message || error || 'Media migration failed').slice(0, 500),
  };
}

async function migrateMediaToR2({
  catalog,
  mediaPromotionService,
  articleId,
  afterFileId = 0,
  limit = 1_000,
  concurrency = DEFAULT_CONCURRENCY,
  dryRun = true,
  writeMode = MEDIA_WRITE_MODE.LOCAL,
  writePaused = false,
} = {}) {
  if (!catalog || typeof catalog.listPublishedFiles !== 'function') throw new TypeError('catalog is required');
  if (!mediaPromotionService || typeof mediaPromotionService.promote !== 'function') {
    throw new TypeError('mediaPromotionService is required');
  }
  const normalizedConcurrency = normalizeConcurrency(concurrency);
  const files = await catalog.listPublishedFiles({ articleId, afterFileId, limit });
  const discovered = await catalog.discoverVariants(files);
  const report = {
    dryRun: dryRun !== false,
    scope: 'published',
    concurrency: normalizedConcurrency,
    reason: null,
    examinedFiles: files.length,
    candidateObjects: discovered.candidates.length,
    candidateBytes: discovered.candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    attempted: 0,
    ready: 0,
    idempotent: 0,
    inProgress: 0,
    failed: 0,
    retainedLocal: discovered.candidates.length,
    missingAssets: discovered.missingAssets,
    invalidRows: discovered.invalidRows,
    failures: [],
    nextAfterFileId: files.length > 0 ? files.at(-1).id : Number(afterFileId || 0),
  };

  if (report.dryRun) return report;
  if (writeMode !== MEDIA_WRITE_MODE.R2_ON_PUBLISH) {
    report.reason = 'write_mode_local';
    return report;
  }
  if (isPaused(writePaused)) {
    report.reason = 'r2_write_paused';
    return report;
  }

  await runBounded(discovered.candidates, normalizedConcurrency, async (candidate) => {
    report.attempted += 1;
    try {
      const promotion = {
        fileId: candidate.fileId,
        variant: candidate.variant,
        localPath: candidate.localPath,
        filename: candidate.filename,
        contentType: candidate.contentType,
      };
      if (candidate.articleId != null) promotion.articleId = candidate.articleId;
      const result = await mediaPromotionService.promote(promotion);
      if (result?.inProgress) {
        report.inProgress += 1;
        return;
      }
      report.ready += 1;
      if (result?.skipped) report.idempotent += 1;
    } catch (error) {
      report.failed += 1;
      report.failures.push(failureFor(candidate, error));
    }
  });
  report.failures.sort((left, right) => left.fileId - right.fileId || left.variant.localeCompare(right.variant));
  return report;
}

module.exports = {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  migrateMediaToR2,
  normalizeConcurrency,
  runBounded,
};
