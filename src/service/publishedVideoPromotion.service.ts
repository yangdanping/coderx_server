import fs from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_VARIANT, MEDIA_WRITE_MODE, type MediaVariant, type MediaWriteMode } from '../constants/mediaStorage.js';
import type { MediaPromotionInput } from './mediaPromotion.service.js';

type VideoVariant = Extract<MediaVariant, 'video' | 'poster'>;
type PromotionState = { enabled: boolean; reason: 'write_mode_local' | 'r2_write_paused' | null };
type VideoPromotionFailure =
  { fileId: number; code: 'LOCAL_VIDEO_ASSET_INCOMPLETE'; missing: VideoVariant[] } | { fileId: number; variant: VideoVariant; code: string; message: string };

interface VideoPromotionSummary extends PromotionState {
  examined: number;
  eligible: number;
  attempted: number;
  ready: number;
  idempotent: number;
  inProgress: number;
  failed: number;
  completed: number;
  skippedNotCompleted: number;
  skippedMissingAssets: number;
  failures: VideoPromotionFailure[];
}

interface PublishedVideoPromotionOptions {
  videoRoot: string;
  writeMode?: string;
  writePaused?: boolean | string;
  mediaPromotionService: {
    promote(payload: MediaPromotionInput): Promise<{ inProgress?: boolean; skipped?: boolean } | null | undefined>;
  };
}

function isWriteMode(value: string): value is MediaWriteMode {
  return value === MEDIA_WRITE_MODE.LOCAL || value === MEDIA_WRITE_MODE.R2_ON_PUBLISH;
}

function hasProperties(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function normalizePositiveId(value: unknown, name: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return normalized;
}

function normalizeFilename(filename: unknown, name: string): string {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError(`${name} must not contain a path`);
  }
  return filename;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (hasProperties(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function posterContentType(filename: string): string {
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

function emptySummary({ enabled, reason }: PromotionState): VideoPromotionSummary {
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

export class PublishedVideoPromotionService {
  declare videoRoot: string;
  declare writeMode: MediaWriteMode;
  declare writePaused: boolean;
  declare mediaPromotionService: PublishedVideoPromotionOptions['mediaPromotionService'];

  constructor({ videoRoot, writeMode = MEDIA_WRITE_MODE.LOCAL, writePaused = false, mediaPromotionService }: PublishedVideoPromotionOptions) {
    if (typeof videoRoot !== 'string' || !videoRoot.trim()) {
      throw new TypeError('videoRoot is required');
    }
    if (!isWriteMode(writeMode)) {
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

  async promotePublishedVideos({ articleId, videos }: { articleId?: number | string | null; videos: readonly unknown[] }): Promise<VideoPromotionSummary> {
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
    const rows: readonly unknown[] = videos;
    for (const row of rows) {
      const video = hasProperties(row) ? row : null;
      summary.examined += 1;
      const fileId = normalizePositiveId(video?.id, 'video.id');
      if (video?.transcode_status !== 'completed') {
        summary.skippedNotCompleted += 1;
        continue;
      }

      const videoFilename = typeof video.filename === 'string' ? video.filename.trim() : '';
      const posterFilename = typeof video.poster === 'string' ? video.poster.trim() : '';
      if (!videoFilename || !posterFilename) {
        summary.skippedMissingAssets += 1;
        summary.failed += 1;
        summary.failures.push({
          fileId,
          code: 'LOCAL_VIDEO_ASSET_INCOMPLETE',
          missing: [!videoFilename ? MEDIA_VARIANT.VIDEO : null, !posterFilename ? MEDIA_VARIANT.POSTER : null].filter((variant) => variant !== null),
        });
        continue;
      }

      const filename = normalizeFilename(videoFilename, 'video.filename');
      const poster = normalizeFilename(posterFilename, 'video.poster');
      const videoPath = path.join(this.videoRoot, filename);
      const posterPath = path.join(this.videoRoot, poster);
      const [hasVideo, hasPoster] = await Promise.all([isRegularFile(videoPath), isRegularFile(posterPath)]);
      if (!hasVideo || !hasPoster) {
        summary.skippedMissingAssets += 1;
        summary.failed += 1;
        summary.failures.push({
          fileId,
          code: 'LOCAL_VIDEO_ASSET_INCOMPLETE',
          missing: [!hasVideo ? MEDIA_VARIANT.VIDEO : null, !hasPoster ? MEDIA_VARIANT.POSTER : null].filter((variant) => variant !== null),
        });
        continue;
      }

      summary.eligible += 1;
      let completed = true;
      const candidates: { variant: VideoVariant; localPath: string; contentType: string }[] = [
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
            code: hasProperties(error) && typeof error.code === 'string' ? error.code : 'MEDIA_PROMOTION_FAILED',
            message: String((hasProperties(error) && error.message) || 'Media promotion failed').slice(0, 500),
          });
        }
      }

      if (completed) summary.completed += 1;
    }
    return summary;
  }
}

export function createPublishedVideoPromotionService(options: PublishedVideoPromotionOptions): PublishedVideoPromotionService {
  return new PublishedVideoPromotionService(options);
}
