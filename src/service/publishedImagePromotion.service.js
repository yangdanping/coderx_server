const fs = require('node:fs/promises');
const path = require('node:path');
const { MEDIA_VARIANT, MEDIA_WRITE_MODE } = require('@/constants/mediaStorage');

function normalizePositiveId(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return normalized;
}

function normalizeFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('image filename must not contain a path');
  }
  return filename;
}

function smallFilename(filename) {
  const extension = path.extname(filename);
  return `${filename.slice(0, -extension.length)}-small${extension}`;
}

async function isRegularFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function emptySummary({ enabled, reason }) {
  return {
    enabled,
    reason,
    attempted: 0,
    ready: 0,
    idempotent: 0,
    inProgress: 0,
    failed: 0,
    failures: [],
  };
}

class PublishedImagePromotionService {
  constructor({ imageRoot, writeMode = MEDIA_WRITE_MODE.LOCAL, writePaused = false, mediaPromotionService }) {
    if (typeof imageRoot !== 'string' || !imageRoot.trim()) {
      throw new TypeError('imageRoot is required');
    }
    if (!Object.values(MEDIA_WRITE_MODE).includes(writeMode)) {
      throw new TypeError(`unsupported media write mode: ${writeMode}`);
    }
    if (!mediaPromotionService || typeof mediaPromotionService.promote !== 'function') {
      throw new TypeError('an injected mediaPromotionService is required');
    }

    this.imageRoot = path.resolve(imageRoot);
    this.writeMode = writeMode;
    this.writePaused = writePaused === true || writePaused === 'true';
    this.mediaPromotionService = mediaPromotionService;
  }

  async promotePublishedImages({ articleId, images }) {
    const normalizedArticleId = normalizePositiveId(articleId, 'articleId');
    if (!Array.isArray(images)) {
      throw new TypeError('images must be an array');
    }
    if (this.writeMode !== MEDIA_WRITE_MODE.R2_ON_PUBLISH) {
      return emptySummary({ enabled: false, reason: 'write_mode_local' });
    }
    if (this.writePaused) {
      return emptySummary({ enabled: false, reason: 'r2_write_paused' });
    }

    const summary = emptySummary({ enabled: true, reason: null });
    for (const image of images) {
      const fileId = normalizePositiveId(image?.id, 'image.id');
      const filename = normalizeFilename(image?.filename);
      const contentType = typeof image?.mimetype === 'string' && image.mimetype ? image.mimetype : 'application/octet-stream';
      const variants = [
        {
          variant: MEDIA_VARIANT.ORIGINAL,
          localPath: path.join(this.imageRoot, filename),
        },
      ];
      const candidateSmallPath = path.join(this.imageRoot, smallFilename(filename));
      if (await isRegularFile(candidateSmallPath)) {
        variants.push({
          variant: MEDIA_VARIANT.SMALL,
          localPath: candidateSmallPath,
        });
      }

      for (const candidate of variants) {
        summary.attempted += 1;
        try {
          const result = await this.mediaPromotionService.promote({
            articleId: normalizedArticleId,
            fileId,
            variant: candidate.variant,
            localPath: candidate.localPath,
            contentType,
          });
          if (result?.inProgress) {
            summary.inProgress += 1;
          } else {
            summary.ready += 1;
            if (result?.skipped) summary.idempotent += 1;
          }
        } catch (error) {
          summary.failed += 1;
          summary.failures.push({
            fileId,
            variant: candidate.variant,
            code: typeof error?.code === 'string' ? error.code : 'MEDIA_PROMOTION_FAILED',
            message: String(error?.message || 'Media promotion failed').slice(0, 500),
          });
        }
      }
    }
    return summary;
  }
}

function createPublishedImagePromotionService(options) {
  return new PublishedImagePromotionService(options);
}

module.exports = {
  PublishedImagePromotionService,
  createPublishedImagePromotionService,
};
