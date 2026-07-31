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

function normalizeFilename(filename, name) {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError(`${name} must not contain a path`);
  }
  return filename;
}

async function isRegularFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function posterContentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function emptySummary({ enabled, reason }) {
  return {
    enabled,
    reason,
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
  };
}

class PublishedVideoPromotionService {
  constructor({ videoRoot, writeMode = MEDIA_WRITE_MODE.LOCAL, writePaused = false, mediaPromotionService }) {
    if (typeof videoRoot !== 'string' || !videoRoot.trim()) {
      throw new TypeError('videoRoot is required');
    }
    if (!Object.values(MEDIA_WRITE_MODE).includes(writeMode)) {
      throw new TypeError(`unsupported media write mode: ${writeMode}`);
    }
    if (!mediaPromotionService || typeof mediaPromotionService.promote !== 'function') {
      throw new TypeError('an injected mediaPromotionService is required');
    }

    this.videoRoot = path.resolve(videoRoot);
    this.writeMode = writeMode;
    this.writePaused = writePaused === true || writePaused === 'true';
    this.mediaPromotionService = mediaPromotionService;
  }

  async promotePublishedVideos({ articleId, videos }) {
    const normalizedArticleId = normalizePositiveId(articleId, 'articleId');
    if (!Array.isArray(videos)) {
      throw new TypeError('videos must be an array');
    }
    if (this.writeMode !== MEDIA_WRITE_MODE.R2_ON_PUBLISH) {
      return emptySummary({ enabled: false, reason: 'write_mode_local' });
    }
    if (this.writePaused) {
      return emptySummary({ enabled: false, reason: 'r2_write_paused' });
    }

    const summary = emptySummary({ enabled: true, reason: null });
    for (const video of videos) {
      summary.examined += 1;
      const fileId = normalizePositiveId(video?.id, 'video.id');
      if (video?.transcode_status !== 'completed') {
        summary.skippedNotCompleted += 1;
        continue;
      }

      const hasVideoFilename = typeof video?.filename === 'string' && video.filename.trim().length > 0;
      const hasPosterFilename = typeof video?.poster === 'string' && video.poster.trim().length > 0;
      if (!hasVideoFilename || !hasPosterFilename) {
        summary.skippedMissingAssets += 1;
        summary.failed += 1;
        summary.failures.push({
          fileId,
          code: 'LOCAL_VIDEO_ASSET_INCOMPLETE',
          missing: [!hasVideoFilename ? MEDIA_VARIANT.VIDEO : null, !hasPosterFilename ? MEDIA_VARIANT.POSTER : null].filter(Boolean),
        });
        continue;
      }

      const filename = normalizeFilename(video.filename.trim(), 'video.filename');
      const poster = normalizeFilename(video.poster.trim(), 'video.poster');
      const videoPath = path.join(this.videoRoot, filename);
      const posterPath = path.join(this.videoRoot, poster);
      const [hasVideo, hasPoster] = await Promise.all([isRegularFile(videoPath), isRegularFile(posterPath)]);
      if (!hasVideo || !hasPoster) {
        summary.skippedMissingAssets += 1;
        summary.failed += 1;
        summary.failures.push({
          fileId,
          code: 'LOCAL_VIDEO_ASSET_INCOMPLETE',
          missing: [!hasVideo ? MEDIA_VARIANT.VIDEO : null, !hasPoster ? MEDIA_VARIANT.POSTER : null].filter(Boolean),
        });
        continue;
      }

      summary.eligible += 1;
      let completed = true;
      const candidates = [
        {
          variant: MEDIA_VARIANT.VIDEO,
          localPath: videoPath,
          contentType: typeof video?.mimetype === 'string' && video.mimetype ? video.mimetype : 'application/octet-stream',
        },
        {
          variant: MEDIA_VARIANT.POSTER,
          localPath: posterPath,
          contentType: posterContentType(poster),
        },
      ];

      for (const candidate of candidates) {
        summary.attempted += 1;
        try {
          const result = await this.mediaPromotionService.promote({
            articleId: normalizedArticleId,
            fileId,
            variant: candidate.variant,
            localPath: candidate.localPath,
            contentType: candidate.contentType,
          });
          if (result?.inProgress) {
            completed = false;
            summary.inProgress += 1;
          } else {
            summary.ready += 1;
            if (result?.skipped) summary.idempotent += 1;
          }
        } catch (error) {
          completed = false;
          summary.failed += 1;
          summary.failures.push({
            fileId,
            variant: candidate.variant,
            code: typeof error?.code === 'string' ? error.code : 'MEDIA_PROMOTION_FAILED',
            message: String(error?.message || 'Media promotion failed').slice(0, 500),
          });
        }
      }

      if (completed) summary.completed += 1;
    }
    return summary;
  }
}

function createPublishedVideoPromotionService(options) {
  return new PublishedVideoPromotionService(options);
}

module.exports = {
  PublishedVideoPromotionService,
  createPublishedVideoPromotionService,
};
