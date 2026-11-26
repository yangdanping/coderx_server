import fs from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_VARIANT, type MediaVariant } from '../constants/mediaStorage.js';
import { buildPublicAssetUrl } from '../utils/publicAssetUrls.js';
import type { QueryExecutor } from '../app/database/database.types.js';

type ImageVariant = Extract<MediaVariant, 'original' | 'small'>;
interface LocalImageUrlOptions {
  database: QueryExecutor;
  imageRoot: string;
  publicApiOrigin?: string;
}

function normalizeFileId(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('fileId must be a positive safe integer');
  }
  return normalized;
}

function normalizeFilename(filename: unknown): string {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('image filename contains an unsafe path');
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
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function createLocalImageUrlResolver({ database, imageRoot, publicApiOrigin }: LocalImageUrlOptions) {
  if (!database || typeof database.execute !== 'function') {
    throw new TypeError('an injected database adapter is required');
  }
  if (typeof imageRoot !== 'string' || !imageRoot.trim()) {
    throw new TypeError('imageRoot is required');
  }
  const resolvedImageRoot = path.resolve(imageRoot);

  return async function resolveLocalImageUrl(fileId: number | string, variant: ImageVariant): Promise<string | null> {
    const normalizedFileId = normalizeFileId(fileId);
    if (![MEDIA_VARIANT.ORIGINAL, MEDIA_VARIANT.SMALL].includes(variant)) {
      throw new TypeError('image variant must be original or small');
    }
    const [rows] = await database.execute(
      `
        SELECT id, filename, file_type
        FROM file
        WHERE id = ?
          AND (file_type = 'image' OR file_type IS NULL)
        LIMIT 1;
      `,
      [normalizedFileId],
    );
    if (!Array.isArray(rows)) throw new TypeError('Image lookup did not return rows');
    const row: unknown = rows[0];
    if (!row) return null;

    const filename = normalizeFilename(typeof row === 'object' && 'filename' in row ? row.filename : undefined);
    const originalUrl = buildPublicAssetUrl(publicApiOrigin, `/article/images/${encodeURIComponent(filename)}`);
    if (variant === MEDIA_VARIANT.ORIGINAL) return originalUrl;

    const thumbnailPath = path.join(resolvedImageRoot, smallFilename(filename));
    return (await isRegularFile(thumbnailPath)) ? `${originalUrl}?type=small` : originalUrl;
  };
}
