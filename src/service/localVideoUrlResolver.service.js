const path = require('node:path');
const { MEDIA_VARIANT } = require('@/constants/mediaStorage');
const { buildPublicAssetUrl } = require('@/utils/publicAssetUrls');

function normalizeFileId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('fileId must be a positive safe integer');
  }
  return normalized;
}

function normalizeFilename(filename, name) {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError(`${name} contains an unsafe path`);
  }
  return filename;
}

function createLocalVideoUrlResolver({ database, publicApiOrigin }) {
  if (!database || typeof database.execute !== 'function') {
    throw new TypeError('an injected database adapter is required');
  }

  return async function resolveLocalVideoUrl(fileId, variant) {
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
    if (!rows[0]) return null;

    if (variant === MEDIA_VARIANT.VIDEO) {
      const filename = normalizeFilename(rows[0].filename, 'video filename');
      return buildPublicAssetUrl(publicApiOrigin, `/article/video/${encodeURIComponent(filename)}`);
    }

    if (typeof rows[0].poster !== 'string' || !rows[0].poster.trim()) return null;
    const poster = normalizeFilename(rows[0].poster.trim(), 'video poster');
    return buildPublicAssetUrl(publicApiOrigin, `/article/video/${encodeURIComponent(poster)}`);
  };
}

module.exports = {
  createLocalVideoUrlResolver,
};
