const fs = require('node:fs/promises');
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

function normalizeFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('image filename contains an unsafe path');
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

function createLocalImageUrlResolver({ database, imageRoot, publicApiOrigin }) {
  if (!database || typeof database.execute !== 'function') {
    throw new TypeError('an injected database adapter is required');
  }
  if (typeof imageRoot !== 'string' || !imageRoot.trim()) {
    throw new TypeError('imageRoot is required');
  }
  const resolvedImageRoot = path.resolve(imageRoot);

  return async function resolveLocalImageUrl(fileId, variant) {
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
    if (!rows[0]) return null;

    const filename = normalizeFilename(rows[0].filename);
    const originalUrl = buildPublicAssetUrl(publicApiOrigin, `/article/images/${encodeURIComponent(filename)}`);
    if (variant === MEDIA_VARIANT.ORIGINAL) return originalUrl;

    const thumbnailPath = path.join(resolvedImageRoot, smallFilename(filename));
    return (await isRegularFile(thumbnailPath)) ? `${originalUrl}?type=small` : originalUrl;
  };
}

module.exports = {
  createLocalImageUrlResolver,
};
