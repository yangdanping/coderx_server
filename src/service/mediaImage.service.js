const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const database = require('@/app/database');
const BusinessError = require('@/errors/BusinessError');
const { IMG_PATH } = require('@/constants/filePaths');
const { baseURL } = require('@/constants/urls');
const { FLOW_IMAGE_MIME_TYPES, MAX_FLOW_IMAGE_FILE_SIZE, MAX_FLOW_IMAGE_PIXELS } = require('@/constants/upload');
const localMediaCleanup = require('@/service/localMediaCleanup.service');
const mediaRuntime = require('@/service/mediaRuntime.service');

const DECODED_FORMAT_TO_MIME = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

function normalizePositiveId(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new BusinessError(`参数错误: ${name} 必须是正整数`, 400);
  }
  return normalized;
}

function formatError() {
  return new BusinessError('图片必须是 JPEG、PNG 或 WebP 格式', 400);
}

function pixelLimitError() {
  return new BusinessError('图片像素不能超过 40,000,000', 400);
}

function localImageUrl(filename, variant, publicApiOrigin) {
  const original = `${String(publicApiOrigin).replace(/\/$/, '')}/article/images/${encodeURIComponent(filename)}`;
  return variant === 'small' ? `${original}?type=small` : original;
}

function createMediaImageService(options = {}) {
  const dependencies = {
    database: options.database || database,
    fsPromises: options.fsPromises || fs,
    imageRoot: path.resolve(options.imageRoot || IMG_PATH),
    localMediaCleanup: options.localMediaCleanup || localMediaCleanup,
    mediaRuntime: options.mediaRuntime || mediaRuntime,
    publicApiOrigin: options.publicApiOrigin || baseURL,
    randomUUID: options.randomUUID || crypto.randomUUID,
    sharp: options.sharp || sharp,
  };

  function imagePath(filename) {
    const resolved = path.resolve(dependencies.imageRoot, filename);
    if (path.dirname(resolved) !== dependencies.imageRoot) {
      throw new TypeError('image path escaped its configured root');
    }
    return resolved;
  }

  async function normalizeImage(buffer, declaredMimeType) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw formatError();
    if (buffer.length > MAX_FLOW_IMAGE_FILE_SIZE) {
      throw new BusinessError('图片大小不能超过 10MB', 400);
    }
    if (!FLOW_IMAGE_MIME_TYPES.has(declaredMimeType)) throw formatError();

    let image;
    let metadata;
    try {
      image = dependencies.sharp(buffer, {
        failOn: 'warning',
        limitInputPixels: MAX_FLOW_IMAGE_PIXELS,
      });
      metadata = await image.metadata();
    } catch (error) {
      if (/input image exceeds pixel limit/i.test(String(error?.message || error))) {
        throw pixelLimitError();
      }
      throw formatError();
    }

    const decodedMimeType = DECODED_FORMAT_TO_MIME[metadata.format];
    if (!decodedMimeType || decodedMimeType !== declaredMimeType) throw formatError();
    const decodedPixels = Number(metadata.width) * Number(metadata.height);
    if (!Number.isSafeInteger(decodedPixels) || decodedPixels > MAX_FLOW_IMAGE_PIXELS) {
      throw pixelLimitError();
    }

    let originalResult;
    let small;
    try {
      originalResult = await image
        .rotate()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      small = await dependencies
        .sharp(originalResult.data)
        .resize({ width: 640, withoutEnlargement: true })
        .webp({ quality: 76 })
        .toBuffer();
    } catch {
      throw formatError();
    }

    const baseName = dependencies.randomUUID();
    const filename = `${baseName}.webp`;
    return {
      filename,
      smallFilename: `${baseName}-small.webp`,
      original: originalResult.data,
      small,
      mimeType: 'image/webp',
      sizeBytes: originalResult.data.length,
      width: Number(originalResult.info.width),
      height: Number(originalResult.info.height),
    };
  }

  async function unlinkGenerated(paths) {
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await dependencies.fsPromises.unlink(filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') console.error(`media image compensation failed for ${filePath}:`, error);
        }
      }),
    );
  }

  async function writeOwnedFile(filePath, buffer, ownedPaths) {
    const handle = await dependencies.fsPromises.open(filePath, 'wx');
    ownedPaths.push(filePath);
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
  }

  async function resolveUrl(fileId, filename, variant) {
    try {
      const resolved = await dependencies.mediaRuntime.resolveImageUrl(fileId, { variant });
      if (resolved) return resolved;
    } catch (error) {
      console.error(`media image URL resolution fell back to local ${variant}:`, error.message);
    }
    return localImageUrl(filename, variant, dependencies.publicApiOrigin);
  }

  async function createPendingImage(userId, file) {
    const normalizedUserId = normalizePositiveId(userId, 'userId');
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw new BusinessError('请选择要上传的图片', 400);
    }
    const normalized = await normalizeImage(file.buffer, file.mimetype);
    const originalPath = imagePath(normalized.filename);
    const smallPath = imagePath(normalized.smallFilename);
    const ownedPaths = [];
    let conn;
    let transactionStarted = false;

    try {
      await dependencies.fsPromises.mkdir(dependencies.imageRoot, { recursive: true });
      await writeOwnedFile(originalPath, normalized.original, ownedPaths);
      await writeOwnedFile(smallPath, normalized.small, ownedPaths);

      conn = await dependencies.database.getConnection();
      await conn.beginTransaction();
      transactionStarted = true;
      const [fileResult] = await conn.execute(
        "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'image') RETURNING id;",
        [normalizedUserId, normalized.filename, normalized.mimeType, normalized.sizeBytes],
      );
      const fileId = Number(fileResult.insertId);
      if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error('image file insert did not return an id');
      await conn.execute('INSERT INTO image_meta (file_id, width, height, is_cover) VALUES (?,?,?,FALSE);', [
        fileId,
        normalized.width,
        normalized.height,
      ]);
      await conn.commit();
      transactionStarted = false;

      return {
        id: fileId,
        url: await resolveUrl(fileId, normalized.filename, 'original'),
        thumbnailUrl: await resolveUrl(fileId, normalized.filename, 'small'),
        mimeType: normalized.mimeType,
        sizeBytes: normalized.sizeBytes,
        width: normalized.width,
        height: normalized.height,
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error('media image transaction rollback failed:', rollbackError);
        }
      }
      await unlinkGenerated(ownedPaths);
      throw error;
    } finally {
      conn?.release();
    }
  }

  async function deletePendingImage(userId, mediaId) {
    const normalizedUserId = normalizePositiveId(userId, 'userId');
    const normalizedMediaId = normalizePositiveId(mediaId, 'mediaId');
    const conn = await dependencies.database.getConnection();
    let cleanupIds = [];

    try {
      await conn.beginTransaction();
      const [probeRows] = await conn.execute(
        `
          SELECT f.id,
                 f.filename,
                 f.file_type,
                 f.article_id,
                 f.draft_id,
                 fm.flow_id
          FROM file f
          LEFT JOIN flow_post_media fm ON fm.file_id = f.id
          WHERE f.id = ?
            AND f.user_id = ?
            AND f.file_type = 'image';
        `,
        [normalizedMediaId, normalizedUserId],
      );
      const probe = probeRows[0];
      if (!probe) {
        await conn.commit();
        return { deleted: false };
      }

      const draftId = probe.draft_id == null ? null : Number(probe.draft_id);
      if (draftId !== null) {
        // Match autosave/publication order: lock the draft before its file.
        const [draftRows] = await conn.execute(
          `
            SELECT id
            FROM draft
            WHERE id = ?
              AND user_id = ?
              AND draft_type = 'flow'
              AND article_id IS NULL
              AND status = 'active'
            FOR UPDATE;
          `,
          [draftId, normalizedUserId],
        );
        if (!draftRows[0]) throw new BusinessError('图片不可删除', 403);
      }

      const [lockedRows] = await conn.execute(
        `
          SELECT f.id,
                 f.filename,
                 f.file_type,
                 f.article_id,
                 f.draft_id,
                 fm.flow_id
          FROM file f
          LEFT JOIN flow_post_media fm ON fm.file_id = f.id
          WHERE f.id = ?
            AND f.user_id = ?
            AND f.file_type = 'image'
          FOR UPDATE OF f;
        `,
        [normalizedMediaId, normalizedUserId],
      );
      const row = lockedRows[0];
      // Revalidate every association after the file lock is acquired.
      if (
        !row ||
        Number(row.id) !== normalizedMediaId ||
        row.file_type !== 'image' ||
        row.article_id != null ||
        row.flow_id != null ||
        (draftId === null ? row.draft_id != null : Number(row.draft_id) !== draftId)
      ) {
        throw new BusinessError('图片不可删除', 403);
      }

      if (draftId !== null) {
        // Preserve version so the next autosave can use its current optimistic-lock value.
        const [draftUpdateResult] = await conn.execute(
          `
            UPDATE draft
            SET meta = jsonb_set(
              COALESCE(meta, '{}'::jsonb),
              '{imageIds}',
              COALESCE(
                (
                  WITH retained_images AS (
                    SELECT image.value AS image_id, image.ordinality
                    FROM jsonb_array_elements(
                      CASE
                        WHEN jsonb_typeof(COALESCE(meta, '{}'::jsonb) -> 'imageIds') = 'array'
                          THEN COALESCE(meta, '{}'::jsonb) -> 'imageIds'
                        ELSE '[]'::jsonb
                      END
                    ) WITH ORDINALITY AS image(value, ordinality)
                    WHERE image.value <> to_jsonb(?::bigint)
                  )
                  SELECT jsonb_agg(image_id ORDER BY ordinality)
                  FROM retained_images
                ),
                '[]'::jsonb
              ),
              true
            )
            WHERE id = ?
              AND user_id = ?
              AND draft_type = 'flow'
              AND article_id IS NULL
              AND status = 'active';
          `,
          [normalizedMediaId, draftId, normalizedUserId],
        );
        if (draftUpdateResult.affectedRows !== 1) {
          throw new Error('deletePendingImage: locked draft metadata was not updated');
        }
      }

      await dependencies.mediaRuntime.deleteR2ObjectsForFiles([normalizedMediaId]);
      const cleanupEntries = dependencies.localMediaCleanup.buildLocalCleanupEntries([row]);
      cleanupIds = await dependencies.localMediaCleanup.enqueueInTransaction(conn, cleanupEntries);
      const [deleteResult] = await conn.execute(
        `
          DELETE FROM file
          WHERE id = ?
            AND user_id = ?
            AND file_type = 'image'
            AND article_id IS NULL
            ${draftId === null ? 'AND draft_id IS NULL' : 'AND draft_id = ?'}
            AND NOT EXISTS (
              SELECT 1 FROM flow_post_media fm WHERE fm.file_id = file.id
            );
        `,
        draftId === null ? [normalizedMediaId, normalizedUserId] : [normalizedMediaId, normalizedUserId, draftId],
      );
      if (deleteResult.affectedRows !== 1) {
        throw new Error('deletePendingImage: locked image was not deleted');
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    if (cleanupIds.length > 0) {
      try {
        await dependencies.localMediaCleanup.processPending({ ids: cleanupIds });
      } catch (error) {
        console.error('deletePendingImage local cleanup deferred for retry:', error.message);
      }
    }
    return { deleted: true };
  }

  return {
    createPendingImage,
    deletePendingImage,
    normalizeImage,
  };
}

const mediaImageService = createMediaImageService();

module.exports = mediaImageService;
module.exports.createMediaImageService = createMediaImageService;
