import fs from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_VARIANT, MEDIA_WRITE_MODE, type MediaVariant, type MediaWriteMode } from '../constants/mediaStorage.js';
import type { MediaPromotionInput } from './mediaPromotion.service.js';

type ImageVariant = Extract<MediaVariant, 'original' | 'small'>;
type PromotionState = { enabled: boolean; reason: 'write_mode_local' | 'r2_write_paused' | null };
type ImagePromotionFailure = { fileId: number; variant: ImageVariant; code: string; message: string };
interface ImagePromotionSummary extends PromotionState {
  attempted: number;
  ready: number;
  idempotent: number;
  inProgress: number;
  failed: number;
  failures: ImagePromotionFailure[];
}

interface PublishedImagePromotionOptions {
  imageRoot: string;
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

function normalizeFilename(filename: unknown): string {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('image filename must not contain a path');
  }
  return filename;
}

function smallFilename(filename: string): string {
  const extension = path.extname(filename);
  return `${filename.slice(0, -extension.length)}-small${extension}`;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (hasProperties(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function emptySummary({ enabled, reason }: PromotionState): ImagePromotionSummary {
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

export class PublishedImagePromotionService {
  declare imageRoot: string;
  declare writeMode: MediaWriteMode;
  declare writePaused: boolean;
  declare mediaPromotionService: PublishedImagePromotionOptions['mediaPromotionService'];

  constructor({ imageRoot, writeMode = MEDIA_WRITE_MODE.LOCAL, writePaused = false, mediaPromotionService }: PublishedImagePromotionOptions) {
    if (typeof imageRoot !== 'string' || !imageRoot.trim()) {
      throw new TypeError('imageRoot is required');
    }
    if (!isWriteMode(writeMode)) {
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

  async promotePublishedImages({ articleId, images }: { articleId?: number | string | null; images: readonly unknown[] }): Promise<ImagePromotionSummary> {
    const normalizedArticleId = articleId == null ? null : normalizePositiveId(articleId, 'articleId');
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
    const rows: readonly unknown[] = images;
    for (const row of rows) {
      const image = hasProperties(row) ? row : null;
      const fileId = normalizePositiveId(image?.id, 'image.id');
      const filename = normalizeFilename(image?.filename);
      const contentType = typeof image?.mimetype === 'string' && image.mimetype ? image.mimetype : 'application/octet-stream';
      const variants: { variant: ImageVariant; localPath: string }[] = [
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
          const promotionPayload: MediaPromotionInput = {
            fileId,
            variant: candidate.variant,
            localPath: candidate.localPath,
            contentType,
          };
          if (normalizedArticleId != null) {
            promotionPayload.articleId = normalizedArticleId;
          }
          const result = await this.mediaPromotionService.promote(promotionPayload);
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
            code: hasProperties(error) && typeof error.code === 'string' ? error.code : 'MEDIA_PROMOTION_FAILED',
            message: String((hasProperties(error) && error.message) || 'Media promotion failed').slice(0, 500),
          });
        }
      }
    }
    return summary;
  }
}

export function createPublishedImagePromotionService(options: PublishedImagePromotionOptions): PublishedImagePromotionService {
  return new PublishedImagePromotionService(options);
}
