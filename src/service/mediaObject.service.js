const { DEFAULT_R2_HARD_LIMIT_BYTES, MEDIA_CAPACITY_ADVISORY_LOCK_KEY, MEDIA_OBJECT_STATUS, MEDIA_PROVIDER, MEDIA_VARIANT } = require('@/constants/mediaStorage');

const VARIANTS = new Set(Object.values(MEDIA_VARIANT));
const ACTIVE_CAPACITY_STATUSES = [MEDIA_OBJECT_STATUS.PENDING, MEDIA_OBJECT_STATUS.READY];

class MediaCapacityExceededError extends Error {
  constructor({ currentBytes, requestedBytes, hardLimitBytes }) {
    super(`R2 media capacity hard limit ${hardLimitBytes} bytes would be exceeded ` + `(current ${currentBytes}, requested ${requestedBytes})`);
    this.name = 'MediaCapacityExceededError';
    this.code = 'MEDIA_R2_HARD_LIMIT_EXCEEDED';
    this.currentBytes = currentBytes;
    this.requestedBytes = requestedBytes;
    this.hardLimitBytes = hardLimitBytes;
  }
}

class MediaObjectConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaObjectConflictError';
    this.code = 'MEDIA_OBJECT_CONFLICT';
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fileId: row.fileId ?? row.file_id,
    provider: row.provider,
    variant: row.variant,
    objectKey: row.objectKey ?? row.object_key ?? null,
    localPath: row.localPath ?? row.local_path ?? null,
    sizeBytes: Number(row.sizeBytes ?? row.size_bytes),
    sha256: row.sha256,
    status: row.status,
    ...(row.lastError !== undefined || row.last_error !== undefined ? { lastError: row.lastError ?? row.last_error } : {}),
    ...(row.verifiedAt !== undefined || row.verified_at !== undefined ? { verifiedAt: row.verifiedAt ?? row.verified_at } : {}),
  };
}

function validateReservation({ fileId, variant, objectKey, sizeBytes, sha256 }) {
  if (!Number.isSafeInteger(Number(fileId)) || Number(fileId) <= 0) {
    throw new TypeError('fileId must be a positive safe integer');
  }
  if (!VARIANTS.has(variant)) {
    throw new TypeError('variant is invalid');
  }
  if (typeof objectKey !== 'string' || !objectKey) {
    throw new TypeError('objectKey is required');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new TypeError('sizeBytes must be a non-negative safe integer');
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError('sha256 must contain 64 lowercase hexadecimal characters');
  }
}

function selectFields() {
  return `
    id,
    file_id AS "fileId",
    provider,
    variant,
    object_key AS "objectKey",
    local_path AS "localPath",
    size_bytes AS "sizeBytes",
    sha256,
    status,
    last_error AS "lastError",
    verified_at AS "verifiedAt"
  `;
}

class MediaObjectService {
  constructor({ database, hardLimitBytes = DEFAULT_R2_HARD_LIMIT_BYTES }) {
    if (!database || typeof database.getConnection !== 'function' || typeof database.execute !== 'function') {
      throw new TypeError('an injected database adapter is required');
    }
    if (!Number.isSafeInteger(Number(hardLimitBytes)) || Number(hardLimitBytes) <= 0) {
      throw new TypeError('hardLimitBytes must be a positive safe integer');
    }
    this.database = database;
    this.hardLimitBytes = Number(hardLimitBytes);
  }

  async getR2ReservedBytes(options = {}) {
    const executor = options.conn || this.database;
    const [rows] = await executor.execute(
      `
        SELECT COALESCE(SUM(size_bytes), 0) AS "reservedBytes"
        FROM media_object
        WHERE provider = 'r2'
          AND status IN (?, ?);
      `,
      ACTIVE_CAPACITY_STATUSES,
    );
    return Number(rows[0]?.reservedBytes ?? rows[0]?.reservedbytes ?? 0);
  }

  async reserveR2Object(payload) {
    validateReservation(payload);
    const fileId = Number(payload.fileId);
    const { variant, objectKey, sizeBytes, sha256 } = payload;
    const conn = await this.database.getConnection();

    try {
      await conn.beginTransaction();
      await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));', [MEDIA_CAPACITY_ADVISORY_LOCK_KEY]);

      const [existingRows] = await conn.execute(
        `
          SELECT ${selectFields()}
          FROM media_object
          WHERE file_id = ?
            AND provider = 'r2'
            AND variant = ?
          FOR UPDATE;
        `,
        [fileId, variant],
      );
      const existing = normalizeRow(existingRows[0]);
      const matches = existing && existing.objectKey === objectKey && existing.sizeBytes === sizeBytes && existing.sha256 === sha256;

      if (existing && ACTIVE_CAPACITY_STATUSES.includes(existing.status)) {
        if (!matches) {
          throw new MediaObjectConflictError(`R2 media row for file ${fileId}/${variant} already reserves different immutable content`);
        }
        await conn.commit();
        return {
          reserved: false,
          reservedBytes: null,
          mediaObject: existing,
        };
      }

      if (existing && existing.status === MEDIA_OBJECT_STATUS.DELETING) {
        throw new MediaObjectConflictError(`R2 media row for file ${fileId}/${variant} is being deleted`);
      }

      const currentBytes = await this.getR2ReservedBytes({ conn });
      if (currentBytes + sizeBytes > this.hardLimitBytes) {
        throw new MediaCapacityExceededError({
          currentBytes,
          requestedBytes: sizeBytes,
          hardLimitBytes: this.hardLimitBytes,
        });
      }

      let mediaObjectId;
      if (existing) {
        await conn.execute(
          `
            UPDATE media_object
            SET object_key = ?,
                size_bytes = ?,
                sha256 = ?,
                status = 'pending',
                last_error = NULL,
                verified_at = NULL,
                updated_at = clock_timestamp()
            WHERE id = ?;
          `,
          [objectKey, sizeBytes, sha256, existing.id],
        );
        mediaObjectId = existing.id;
      } else {
        const [insertResult] = await conn.execute(
          `
            INSERT INTO media_object (
              file_id,
              provider,
              variant,
              object_key,
              size_bytes,
              sha256,
              status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id;
          `,
          [fileId, MEDIA_PROVIDER.R2, variant, objectKey, sizeBytes, sha256, MEDIA_OBJECT_STATUS.PENDING],
        );
        mediaObjectId = insertResult.insertId;
      }

      const mediaObject = {
        id: mediaObjectId,
        fileId,
        provider: MEDIA_PROVIDER.R2,
        variant,
        objectKey,
        localPath: null,
        sizeBytes,
        sha256,
        status: MEDIA_OBJECT_STATUS.PENDING,
      };

      await conn.commit();
      return {
        reserved: true,
        reservedBytes: currentBytes + sizeBytes,
        mediaObject,
      };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async markReady(mediaObjectId) {
    const [result] = await this.database.execute(
      `
        UPDATE media_object
        SET status = 'ready',
            last_error = NULL,
            verified_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ?
          AND status IN ('pending', 'ready');
      `,
      [mediaObjectId],
    );
    return result;
  }

  async markFailed(mediaObjectId, error) {
    const message = String(error?.message || error || 'Unknown media promotion error').slice(0, 2000);
    const [result] = await this.database.execute(
      `
        UPDATE media_object
        SET status = 'failed',
            last_error = ?,
            verified_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = ?
          AND status = 'pending';
      `,
      [message, mediaObjectId],
    );
    return result;
  }

  async findReadyR2Objects(fileId) {
    const [rows] = await this.database.execute(
      `
        SELECT ${selectFields()}
        FROM media_object
        WHERE file_id = ?
          AND provider = 'r2'
          AND status = 'ready';
      `,
      [fileId],
    );
    return rows.map(normalizeRow);
  }
}

function createMediaObjectService(options) {
  return new MediaObjectService(options);
}

module.exports = {
  MediaCapacityExceededError,
  MediaObjectConflictError,
  MediaObjectService,
  createMediaObjectService,
};
