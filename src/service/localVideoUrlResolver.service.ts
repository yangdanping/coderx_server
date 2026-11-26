import path from 'node:path';
import { MEDIA_VARIANT, type MediaVariant } from '../constants/mediaStorage.js';
import { buildPublicAssetUrl } from '../utils/publicAssetUrls.js';
import type { QueryExecutor } from '../app/database/database.types.js';

type VideoVariant = Extract<MediaVariant, 'video' | 'poster'>;
interface LocalVideoUrlOptions {
  database: QueryExecutor;
  publicApiOrigin?: string;
}

function normalizeFileId(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('fileId must be a positive safe integer');
  }
  return normalized;
}

function normalizeFilename(filename: unknown, name: string): string {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError(`${name} contains an unsafe path`);
  }
  return filename;
}

export function createLocalVideoUrlResolver({ database, publicApiOrigin }: LocalVideoUrlOptions) {
  if (!database || typeof database.execute !== 'function') {
    throw new TypeError('an injected database adapter is required');
  }

  return async function resolveLocalVideoUrl(fileId: number | string, variant: VideoVariant): Promise<string | null> {
    const normalizedFileId = normalizeFileId(fileId);
    if (![MEDIA_VARIANT.VIDEO, MEDIA_VARIANT.POSTER].includes(variant)) {
      throw new TypeError('video variant must be video or poster');
    }
    const [rows] = await database.execute(
      `
        SELECT f.id, f.filename, f.file_type, vm.poster
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE f.id = ?
          AND f.file_type = 'video'
        LIMIT 1;
      `,
      [normalizedFileId],
    );
    if (!Array.isArray(rows)) throw new TypeError('Video lookup did not return rows');
    const row: unknown = rows[0];
    if (!row) return null;

    if (variant === MEDIA_VARIANT.VIDEO) {
      const filename = normalizeFilename(typeof row === 'object' && 'filename' in row ? row.filename : undefined, 'video filename');
      return buildPublicAssetUrl(publicApiOrigin, `/article/video/${encodeURIComponent(filename)}`);
    }

    const value = typeof row === 'object' && 'poster' in row ? row.poster : undefined;
    if (typeof value !== 'string' || !value.trim()) return null;
    const poster = normalizeFilename(value.trim(), 'video poster');
    return buildPublicAssetUrl(publicApiOrigin, `/article/video/${encodeURIComponent(poster)}`);
  };
}
