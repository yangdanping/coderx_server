const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_LIMIT = 1_000;

function positiveInteger(value, name, fallback) {
  if (value == null && fallback != null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, name, fallback = 0) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function normalizeFileRow(row) {
  return {
    id: Number(row.id),
    articleId: Number(row.articleId ?? row.article_id),
    filename: row.filename,
    mimetype: row.mimetype,
    // Historical image rows predate file_type; the existing read path also treats
    // an attached NULL file_type as an image.
    fileType: row.fileType ?? row.file_type ?? 'image',
    poster: row.poster ?? null,
    transcodeStatus: row.transcodeStatus ?? row.transcode_status ?? null,
  };
}

function isSafeFilename(filename) {
  return typeof filename === 'string' && filename.length > 0 && filename === path.basename(filename) && !filename.includes('/') && !filename.includes('\\');
}

function smallFilename(filename) {
  const extension = path.extname(filename);
  return extension ? `${filename.slice(0, -extension.length)}-small${extension}` : `${filename}-small`;
}

function contentTypeForFilename(filename, fallback = 'application/octet-stream') {
  const extension = path.extname(filename).toLowerCase();
  const types = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  };
  return types[extension] || fallback;
}

async function regularFileSize(filePath, filesystem = fs) {
  try {
    const stats = await filesystem.lstat(filePath);
    return stats.isFile() && !stats.isSymbolicLink() ? stats.size : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function walkRegularFiles(root, filesystem = fs) {
  const found = [];
  let entries;
  try {
    entries = await filesystem.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkRegularFiles(candidate, filesystem)));
    } else if (entry.isFile()) {
      found.push(path.resolve(candidate));
    }
  }
  return found.sort();
}

function createMediaCatalog({ database, imageRoot, videoRoot, filesystem = fs }) {
  if (!database || typeof database.execute !== 'function') throw new TypeError('database is required');
  if (typeof imageRoot !== 'string' || !imageRoot) throw new TypeError('imageRoot is required');
  if (typeof videoRoot !== 'string' || !videoRoot) throw new TypeError('videoRoot is required');
  const resolvedImageRoot = path.resolve(imageRoot);
  const resolvedVideoRoot = path.resolve(videoRoot);

  async function listPublishedFiles({ articleId, afterFileId = 0, limit = DEFAULT_LIMIT } = {}) {
    const normalizedAfterFileId = nonNegativeInteger(afterFileId, 'afterFileId');
    const normalizedLimit = positiveInteger(limit, 'limit', DEFAULT_LIMIT);
    const normalizedArticleId = articleId == null ? null : positiveInteger(articleId, 'articleId');
    const params = [normalizedAfterFileId];
    const articleFilter = normalizedArticleId == null ? '' : 'AND f.article_id = ?';
    if (normalizedArticleId != null) params.push(normalizedArticleId);
    params.push(normalizedLimit);
    const [rows] = await database.execute(
      `
        SELECT
          f.id,
          f.article_id AS "articleId",
          f.filename,
          f.mimetype,
          f.file_type AS "fileType",
          vm.poster,
          vm.transcode_status AS "transcodeStatus"
        FROM file f
        LEFT JOIN video_meta vm ON vm.file_id = f.id
        WHERE f.article_id IS NOT NULL
          AND f.id > ?
          ${articleFilter}
        ORDER BY f.id ASC
        LIMIT ?;
      `,
      params,
    );
    return rows.map(normalizeFileRow);
  }

  async function discoverVariants(fileRows) {
    if (!Array.isArray(fileRows)) throw new TypeError('fileRows must be an array');
    const result = { candidates: [], missingAssets: [], optionalMissingAssets: [], invalidRows: [] };
    for (const rawRow of fileRows) {
      const row = normalizeFileRow(rawRow);
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.articleId) || row.articleId <= 0 || !isSafeFilename(row.filename)) {
        result.invalidRows.push({ fileId: row.id, articleId: row.articleId, code: 'UNSAFE_FILENAME' });
        continue;
      }
      if (row.fileType === 'image') {
        const originalPath = path.join(resolvedImageRoot, row.filename);
        const originalSize = await regularFileSize(originalPath, filesystem);
        if (originalSize == null) {
          result.missingAssets.push({ fileId: row.id, articleId: row.articleId, variant: 'original' });
        } else {
          result.candidates.push({
            articleId: row.articleId,
            fileId: row.id,
            fileType: 'image',
            variant: 'original',
            localPath: originalPath,
            filename: row.filename,
            contentType: row.mimetype || contentTypeForFilename(row.filename),
            sizeBytes: originalSize,
          });
        }
        const small = smallFilename(row.filename);
        const smallPath = path.join(resolvedImageRoot, small);
        const smallSize = await regularFileSize(smallPath, filesystem);
        if (smallSize == null) {
          result.optionalMissingAssets.push({ fileId: row.id, articleId: row.articleId, variant: 'small' });
        } else {
          result.candidates.push({
            articleId: row.articleId,
            fileId: row.id,
            fileType: 'image',
            variant: 'small',
            localPath: smallPath,
            filename: small,
            contentType: contentTypeForFilename(small, row.mimetype || 'application/octet-stream'),
            sizeBytes: smallSize,
          });
        }
        continue;
      }
      if (row.fileType === 'video') {
        if (row.transcodeStatus !== 'completed') {
          result.invalidRows.push({ fileId: row.id, articleId: row.articleId, code: 'VIDEO_NOT_COMPLETED', transcodeStatus: row.transcodeStatus });
          continue;
        }
        if (!isSafeFilename(row.poster)) {
          result.invalidRows.push({ fileId: row.id, articleId: row.articleId, code: 'UNSAFE_POSTER_FILENAME' });
          continue;
        }
        const variants = [
          { variant: 'video', filename: row.filename, contentType: row.mimetype || contentTypeForFilename(row.filename) },
          { variant: 'poster', filename: row.poster, contentType: contentTypeForFilename(row.poster) },
        ];
        for (const variant of variants) {
          const localPath = path.join(resolvedVideoRoot, variant.filename);
          const sizeBytes = await regularFileSize(localPath, filesystem);
          if (sizeBytes == null) {
            result.missingAssets.push({ fileId: row.id, articleId: row.articleId, variant: variant.variant });
          } else {
            result.candidates.push({
              articleId: row.articleId,
              fileId: row.id,
              fileType: 'video',
              variant: variant.variant,
              localPath,
              filename: variant.filename,
              contentType: variant.contentType,
              sizeBytes,
            });
          }
        }
        continue;
      }
      result.invalidRows.push({ fileId: row.id, articleId: row.articleId, code: 'UNSUPPORTED_FILE_TYPE' });
    }
    return result;
  }

  async function listFilesystemFiles() {
    return [...(await walkRegularFiles(resolvedImageRoot, filesystem)), ...(await walkRegularFiles(resolvedVideoRoot, filesystem))].sort();
  }

  function expectedPaths(fileRows) {
    const expected = new Set();
    for (const rawRow of fileRows) {
      const row = normalizeFileRow(rawRow);
      if (!isSafeFilename(row.filename)) continue;
      if (row.fileType === 'image') {
        expected.add(path.join(resolvedImageRoot, row.filename));
        expected.add(path.join(resolvedImageRoot, smallFilename(row.filename)));
      } else if (row.fileType === 'video') {
        expected.add(path.join(resolvedVideoRoot, row.filename));
        if (isSafeFilename(row.poster)) expected.add(path.join(resolvedVideoRoot, row.poster));
      }
    }
    return expected;
  }

  return {
    listPublishedFiles,
    discoverVariants,
    listFilesystemFiles,
    expectedPaths,
    imageRoot: resolvedImageRoot,
    videoRoot: resolvedVideoRoot,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  contentTypeForFilename,
  createMediaCatalog,
  isSafeFilename,
  smallFilename,
};
