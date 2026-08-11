const path = require('node:path');
const { MEDIA_VARIANT } = require('@/constants/mediaStorage');

const IMAGE_VARIANTS = new Set([MEDIA_VARIANT.ORIGINAL, MEDIA_VARIANT.SMALL]);
const VIDEO_VARIANTS = new Set([MEDIA_VARIANT.VIDEO, MEDIA_VARIANT.POSTER]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_PATTERN = /^[a-z0-9]+$/;

function normalizePositiveId(value, name) {
  const text = typeof value === 'number' ? String(value) : value;
  if (!/^[1-9][0-9]*$/.test(text || '')) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a safe positive integer`);
  }
  return parsed;
}

function extensionFromFilename(filename) {
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename || /[\\/]/.test(filename)) {
    throw new TypeError('filename must not contain a path');
  }

  return path.extname(filename).slice(1);
}

function normalizeExtension({ extension, filename }) {
  let candidate = extension;
  if (candidate == null) {
    candidate = extensionFromFilename(filename);
  }

  if (typeof candidate !== 'string') {
    throw new TypeError('extension is required');
  }

  const normalized = candidate.replace(/^\./, '').toLowerCase();
  if (!normalized || !EXTENSION_PATTERN.test(normalized)) {
    throw new TypeError('extension must be a safe file extension');
  }
  return normalized;
}

function buildMediaObjectKey({ articleId, fileId, sha256, variant, extension, filename } = {}) {
  const scope = articleId == null
    ? 'media'
    : `articles/${normalizePositiveId(articleId, 'articleId')}`;
  const normalizedFileId = normalizePositiveId(fileId, 'fileId');
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new TypeError('sha256 must contain exactly 64 lowercase hexadecimal characters');
  }

  let mediaDirectory;
  if (IMAGE_VARIANTS.has(variant)) {
    mediaDirectory = 'images';
  } else if (VIDEO_VARIANTS.has(variant)) {
    mediaDirectory = 'videos';
  } else {
    throw new TypeError('variant is invalid');
  }

  const normalizedExtension = normalizeExtension({ extension, filename });
  return `${scope}/${mediaDirectory}/${normalizedFileId}/${sha256.slice(0, 12)}-${variant}.${normalizedExtension}`;
}

module.exports = {
  buildMediaObjectKey,
};
