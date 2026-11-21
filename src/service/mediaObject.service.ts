import type { DatabaseAdapter, MutationResult, QueryExecutor, SqlRow } from '../app/database/database.types.js';
import {
  DEFAULT_R2_HARD_LIMIT_BYTES,
  MEDIA_CAPACITY_ADVISORY_LOCK_KEY,
  MEDIA_OBJECT_STATUS,
  MEDIA_PROVIDER,
  MEDIA_VARIANT,
  type MediaObjectStatus,
  type MediaProvider,
  type MediaVariant,
} from '../constants/mediaStorage.js';

const VARIANTS = new Set<unknown>(Object.values(MEDIA_VARIANT));
const PROVIDERS = new Set<unknown>(Object.values(MEDIA_PROVIDER));
const STATUSES = new Set<unknown>(Object.values(MEDIA_OBJECT_STATUS));
const ACTIVE_CAPACITY_STATUSES: MediaObjectStatus[] = [MEDIA_OBJECT_STATUS.PENDING, MEDIA_OBJECT_STATUS.READY];

export interface MediaObjectRow {
  id: number | string;
  fileId: number | string;
  provider: MediaProvider;
  variant: MediaVariant;
  objectKey: string | null;
  localPath: string | null;
  sizeBytes: number;
  sha256: string;
  status: MediaObjectStatus;
  lastError?: string | null;
  verifiedAt?: Date | string | null;
}

export interface MediaReservation {
  fileId: number | string;
  variant: MediaVariant;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
}

type ReservationResult = { reserved: false; reservedBytes: null; mediaObject: MediaObjectRow } | { reserved: true; reservedBytes: number; mediaObject: MediaObjectRow };
type TransitionIdentity = Pick<MediaObjectRow, 'id' | 'objectKey' | 'sizeBytes' | 'sha256'>;
type AppliedMutation = Pick<MutationResult, 'affectedRows'>;
type DeletableMediaObject = MediaObjectRow & { objectKey: string };
interface MediaObjectServiceOptions {
  database: DatabaseAdapter;
  hardLimitBytes?: number | string;
}

type CapacityDetails = { currentBytes: number; requestedBytes: number; hardLimitBytes: number };

export class MediaCapacityExceededError extends Error {
  declare code: 'MEDIA_R2_HARD_LIMIT_EXCEEDED';
  declare currentBytes: number;
  declare requestedBytes: number;
  declare hardLimitBytes: number;

  constructor({ currentBytes, requestedBytes, hardLimitBytes }: CapacityDetails) {
    super(`R2 media capacity hard limit ${hardLimitBytes} bytes would be exceeded ` + `(current ${currentBytes}, requested ${requestedBytes})`);
    this.name = 'MediaCapacityExceededError';
    this.code = 'MEDIA_R2_HARD_LIMIT_EXCEEDED';
    this.currentBytes = currentBytes;
    this.requestedBytes = requestedBytes;
    this.hardLimitBytes = hardLimitBytes;
  }
}

export class MediaObjectConflictError extends Error {
  declare code: 'MEDIA_OBJECT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'MediaObjectConflictError';
    this.code = 'MEDIA_OBJECT_CONFLICT';
  }
}

export class MediaObjectStateTransitionError extends Error {
  declare code: 'MEDIA_OBJECT_STATE_TRANSITION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'MediaObjectStateTransitionError';
    this.code = 'MEDIA_OBJECT_STATE_TRANSITION_FAILED';
  }
}

function isRecord(value: unknown): value is SqlRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Media object query did not return rows');
  return value;
}

function isSafeId(value: unknown): value is number | string {
  return (typeof value === 'number' || typeof value === 'string') && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function isMediaProvider(value: unknown): value is MediaProvider {
  return PROVIDERS.has(value);
}

function isMediaVariant(value: unknown): value is MediaVariant {
  return VARIANTS.has(value);
}

function isMediaStatus(value: unknown): value is MediaObjectStatus {
  return STATUSES.has(value);
}

function normalizeRow(row: unknown): MediaObjectRow {
  if (!isRecord(row)) throw new TypeError('Media object query returned an invalid row');
  const { id, provider, variant, sha256, status } = row;
  const fileId = row.fileId ?? row.file_id;
  const objectKey = row.objectKey ?? row.object_key ?? null;
  const localPath = row.localPath ?? row.local_path ?? null;
  const sizeBytes = Number(row.sizeBytes ?? row.size_bytes);
  const lastError = row.lastError ?? row.last_error;
  const verifiedAt = row.verifiedAt ?? row.verified_at;
  if (
    !isSafeId(id) ||
    !isSafeId(fileId) ||
    !isMediaProvider(provider) ||
    !isMediaVariant(variant) ||
    (objectKey !== null && typeof objectKey !== 'string') ||
    (localPath !== null && typeof localPath !== 'string') ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    typeof sha256 !== 'string' ||
    !isMediaStatus(status) ||
    (lastError != null && typeof lastError !== 'string') ||
    (verifiedAt != null && typeof verifiedAt !== 'string' && !(verifiedAt instanceof Date))
  ) {
    throw new TypeError('Media object query returned an invalid row');
  }
  return {
    id,
    fileId,
    provider,
    variant,
    objectKey,
    localPath,
    sizeBytes,
    sha256,
    status,
    ...(row.lastError !== undefined || row.last_error !== undefined ? { lastError } : {}),
    ...(row.verifiedAt !== undefined || row.verified_at !== undefined ? { verifiedAt } : {}),
  };
}

function normalizeDeletableRow(row: unknown): DeletableMediaObject {
  const object = normalizeRow(row);
  if (object.objectKey === null) throw new TypeError('R2 media object is missing its objectKey');
  return { ...object, objectKey: object.objectKey };
}

function normalizeFileIds(fileIds: readonly (number | string)[]): number[] {
  if (!Array.isArray(fileIds)) {
    throw new TypeError('fileIds must be an array');
  }
  const normalized = fileIds.map((fileId) => {
    const value = Number(fileId);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('fileIds must contain only positive safe integers');
    }
    return value;
  });
  return Array.from(new Set(normalized));
}

function validateReservation({ fileId, variant, objectKey, sizeBytes, sha256 }: MediaReservation): void {
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

function normalizeTransitionIdentity(mediaObject: TransitionIdentity) {
  const id = Number(mediaObject?.id);
  const sizeBytes = Number(mediaObject?.sizeBytes);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError('mediaObject.id must be a positive safe integer');
  }
  if (typeof mediaObject?.objectKey !== 'string' || !mediaObject.objectKey) {
    throw new TypeError('mediaObject.objectKey is required');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new TypeError('mediaObject.sizeBytes must be a non-negative safe integer');
  }
  if (typeof mediaObject?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(mediaObject.sha256)) {
    throw new TypeError('mediaObject.sha256 must contain 64 lowercase hexadecimal characters');
  }
  return {
    id,
    objectKey: mediaObject.objectKey,
    sizeBytes,
    sha256: mediaObject.sha256,
  };
}

function hasAffectedRows(result: unknown, count: number): result is AppliedMutation {
  return isRecord(result) && result.affectedRows === count;
}

function assertTransitionApplied(result: unknown, transition: MediaObjectStatus, mediaObjectId: number): AppliedMutation {
  if (!hasAffectedRows(result, 1)) {
    throw new MediaObjectStateTransitionError(`Media object ${mediaObjectId} could not transition to ${transition}; its state or immutable identity changed`);
  }
  return result;
}

function errorMessage(error: unknown, fallback: string): string {
  const message: unknown = error !== null && (typeof error === 'object' || typeof error === 'function') ? Reflect.get(error, 'message') : undefined;
  return String(message || error || fallback).slice(0, 2000);
}

function selectFields(): string {
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

export class MediaObjectService {
  declare database: DatabaseAdapter;
  declare hardLimitBytes: number;

  constructor({ database, hardLimitBytes = DEFAULT_R2_HARD_LIMIT_BYTES }: MediaObjectServiceOptions) {
    if (!database || typeof database.getConnection !== 'function' || typeof database.execute !== 'function') {
      throw new TypeError('an injected database adapter is required');
    }
    if (!Number.isSafeInteger(Number(hardLimitBytes)) || Number(hardLimitBytes) <= 0) {
      throw new TypeError('hardLimitBytes must be a positive safe integer');
    }
    this.database = database;
    this.hardLimitBytes = Number(hardLimitBytes);
  }

  async getR2ReservedBytes(options: { conn?: QueryExecutor | null } = {}): Promise<number> {
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
    const row = readRows(rows)[0];
    const value = isRecord(row) ? (row.reservedBytes ?? row.reservedbytes ?? 0) : 0;
    const reservedBytes = Number(value);
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) throw new TypeError('R2 reserved bytes must be a non-negative safe integer');
    return reservedBytes;
  }

  async reserveR2Object(payload: MediaReservation): Promise<ReservationResult> {
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
      const existingRow = readRows(existingRows)[0];
      const existing = existingRow ? normalizeRow(existingRow) : null;
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

      let mediaObjectId: MediaObjectRow['id'];
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
        if (!isRecord(insertResult) || !isSafeId(insertResult.insertId)) throw new TypeError('Media object insert did not return a valid insertId');
        mediaObjectId = insertResult.insertId;
      }

      const mediaObject: MediaObjectRow = {
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

  async markReady(mediaObject: TransitionIdentity): Promise<AppliedMutation> {
    const identity = normalizeTransitionIdentity(mediaObject);
    const [result] = await this.database.execute(
      `
        UPDATE media_object
        SET status = 'ready',
            last_error = NULL,
            verified_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ?
          AND object_key = ?
          AND size_bytes = ?
          AND sha256 = ?
          AND status = 'pending';
      `,
      [identity.id, identity.objectKey, identity.sizeBytes, identity.sha256],
    );
    return assertTransitionApplied(result, MEDIA_OBJECT_STATUS.READY, identity.id);
  }

  async markFailed(mediaObject: TransitionIdentity, error: unknown): Promise<AppliedMutation> {
    const identity = normalizeTransitionIdentity(mediaObject);
    const message = errorMessage(error, 'Unknown media promotion error');
    const [result] = await this.database.execute(
      `
        UPDATE media_object
        SET status = 'failed',
            last_error = ?,
            verified_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = ?
          AND object_key = ?
          AND size_bytes = ?
          AND sha256 = ?
          AND status = 'pending';
      `,
      [message, identity.id, identity.objectKey, identity.sizeBytes, identity.sha256],
    );
    return assertTransitionApplied(result, MEDIA_OBJECT_STATUS.FAILED, identity.id);
  }

  async markVerificationFailed(mediaObject: TransitionIdentity, error: unknown): Promise<AppliedMutation> {
    const identity = normalizeTransitionIdentity(mediaObject);
    const message = errorMessage(error, 'R2 object verification failed');
    const [result] = await this.database.execute(
      `
        UPDATE media_object
        SET status = 'failed',
            last_error = ?,
            verified_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = ?
          AND object_key = ?
          AND size_bytes = ?
          AND sha256 = ?
          AND status = 'ready';
      `,
      [message, identity.id, identity.objectKey, identity.sizeBytes, identity.sha256],
    );
    return assertTransitionApplied(result, MEDIA_OBJECT_STATUS.FAILED, identity.id);
  }

  async findReadyR2Objects(fileId: number | string): Promise<MediaObjectRow[]> {
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
    return readRows(rows).map(normalizeRow);
  }

  async prepareR2Deletion(fileIds: readonly (number | string)[]): Promise<DeletableMediaObject[]> {
    const normalizedFileIds = normalizeFileIds(fileIds);
    if (normalizedFileIds.length === 0) return [];
    const conn = await this.database.getConnection();

    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        `
          SELECT ${selectFields()}
          FROM media_object
          WHERE file_id = ANY(?::bigint[])
            AND provider = 'r2'
            AND object_key IS NOT NULL
          ORDER BY id ASC
          FOR UPDATE;
        `,
        [normalizedFileIds],
      );
      const objects = readRows(rows).map(normalizeDeletableRow);
      const pendingObjects = objects.filter((object) => object.status === MEDIA_OBJECT_STATUS.PENDING);
      if (pendingObjects.length > 0) {
        throw new MediaObjectConflictError(`R2 upload is still pending for media object ${pendingObjects[0].id}; retry deletion later`);
      }
      if (objects.length > 0) {
        const [result] = await conn.execute(
          `
            UPDATE media_object
            SET status = 'deleting',
                last_error = NULL,
                updated_at = clock_timestamp()
            WHERE id = ANY(?::bigint[]);
          `,
          [objects.map((object) => object.id)],
        );
        if (!hasAffectedRows(result, objects.length)) {
          throw new MediaObjectStateTransitionError('Not every R2 media object could transition to deleting');
        }
      }
      await conn.commit();
      return objects;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
}

export function createMediaObjectService(options: MediaObjectServiceOptions): MediaObjectService {
  return new MediaObjectService(options);
}
