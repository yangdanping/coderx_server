import fs from 'node:fs/promises';
import path from 'node:path';
import { IMG_PATH, VIDEO_PATH } from '../constants/filePaths.js';
import type { DatabaseAdapter, DatabaseTransaction, QueryExecutor } from '../app/database/database.types.js';
import type { ArticleCleanup } from './article/article.types.js';

type CleanupEntry = ReturnType<ArticleCleanup['buildLocalCleanupEntries']>[number];
type CleanupMediaRows = Parameters<ArticleCleanup['buildLocalCleanupEntries']>[0];
type CleanupSummary = Awaited<ReturnType<ArticleCleanup['processPending']>>;
type StorageArea = CleanupEntry['storageArea'];
type CleanupRow = { id: string | number; storageArea: string; filename: string };

interface CleanupOptions {
  database: Pick<DatabaseAdapter, 'getConnection'>;
  fsPromises?: Pick<typeof fs, 'unlink'>;
  roots?: Partial<Record<StorageArea, string>>;
}

interface PendingOptions {
  ids?: readonly (number | string)[] | null;
  limit?: number | string;
  conn?: DatabaseTransaction | null;
}

function normalizeFilename(filename: unknown): string {
  if (typeof filename !== 'string' || !filename || filename !== filename.trim() || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('cleanup filename must be a safe basename');
  }
  return filename;
}

function normalizeEntry(entry: { storageArea: unknown; filename: unknown }): CleanupEntry {
  if (entry?.storageArea !== 'image' && entry?.storageArea !== 'video') {
    throw new TypeError('cleanup storageArea must be image or video');
  }
  return {
    storageArea: entry.storageArea,
    filename: normalizeFilename(entry.filename),
  };
}

function smallImageFilename(filename: string): string {
  const extension = path.extname(filename);
  return `${filename.slice(0, filename.length - extension.length)}-small${extension}`;
}

export function buildLocalCleanupEntries(mediaRows: CleanupMediaRows = []): CleanupEntry[] {
  const entries: CleanupEntry[] = [];
  for (const row of mediaRows) {
    if (row?.file_type === 'video') {
      if (row.filename) entries.push({ storageArea: 'video', filename: row.filename });
      if (row.poster) entries.push({ storageArea: 'video', filename: row.poster });
    } else if (row?.filename) {
      entries.push({ storageArea: 'image', filename: row.filename });
      entries.push({ storageArea: 'image', filename: smallImageFilename(row.filename) });
    }
  }
  const unique = new Map<string, CleanupEntry>();
  for (const entry of entries.map(normalizeEntry)) {
    unique.set(`${entry.storageArea}:${entry.filename}`, entry);
  }
  return [...unique.values()];
}

function normalizeIds(ids: unknown): number[] | null {
  if (ids == null) return null;
  if (!Array.isArray(ids)) throw new TypeError('cleanup ids must be an array');
  const normalized = Array.from(new Set(ids.map(Number)));
  if (normalized.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError('cleanup ids must contain positive safe integers');
  }
  return normalized;
}

function readRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Local media cleanup query did not return rows');
  return value;
}

function isSafeId(value: unknown): value is number | string {
  return (typeof value === 'number' || typeof value === 'string') && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function readCleanupRows(value: unknown): CleanupRow[] {
  return readRows(value).map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      !isSafeId(row.id) ||
      !('storageArea' in row) ||
      typeof row.storageArea !== 'string' ||
      !('filename' in row) ||
      typeof row.filename !== 'string'
    ) {
      throw new TypeError('Local media cleanup query returned an invalid tombstone');
    }
    return { id: row.id, storageArea: row.storageArea, filename: row.filename };
  });
}

function errorProperty(error: unknown, key: 'code' | 'message'): unknown {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) return Reflect.get(error, key);
  return undefined;
}

export class LocalMediaCleanupService {
  declare database: Pick<DatabaseAdapter, 'getConnection'>;
  declare fs: Pick<typeof fs, 'unlink'>;
  declare roots: Record<StorageArea, string>;

  constructor({ database, fsPromises = fs, roots }: CleanupOptions) {
    if (!database || typeof database.getConnection !== 'function') {
      throw new TypeError('a database with getConnection is required');
    }
    if (!fsPromises || typeof fsPromises.unlink !== 'function') {
      throw new TypeError('fsPromises.unlink is required');
    }
    this.database = database;
    this.fs = fsPromises;
    this.roots = {
      image: path.resolve(roots?.image || IMG_PATH),
      video: path.resolve(roots?.video || VIDEO_PATH),
    };
  }

  async enqueueInTransaction(conn: QueryExecutor, entries: readonly CleanupEntry[]): Promise<number[]> {
    if (!conn || typeof conn.execute !== 'function') {
      throw new TypeError('transaction connection is required');
    }
    const ids = [];
    for (const entry of entries.map(normalizeEntry)) {
      const [result] = await conn.execute(
        `
          INSERT INTO media_local_cleanup (storage_area, filename)
          VALUES (?, ?)
          ON CONFLICT (storage_area, filename) DO UPDATE
          SET updated_at = clock_timestamp()
          RETURNING id;
        `,
        [entry.storageArea, entry.filename],
      );
      if (typeof result !== 'object' || result === null || !('insertId' in result) || !isSafeId(result.insertId)) {
        throw new TypeError('Local media cleanup mutation did not return insertId');
      }
      ids.push(Number(result.insertId));
    }
    return ids;
  }

  async processPending({ ids = null, limit = 100, conn: borrowedConnection = null }: PendingOptions = {}): Promise<CleanupSummary> {
    const normalizedIds = normalizeIds(ids);
    const normalizedLimit = Number(limit);
    if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit <= 0 || normalizedLimit > 1000) {
      throw new TypeError('cleanup limit must be an integer between 1 and 1000');
    }
    if (normalizedIds && normalizedIds.length === 0) {
      return { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
    }

    const conn = borrowedConnection || (await this.database.getConnection());
    const summary: CleanupSummary = { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
    try {
      if (!borrowedConnection) await conn.beginTransaction();
      const params: (number[] | number)[] = [];
      let idClause = '';
      if (normalizedIds) {
        idClause = 'WHERE id = ANY(?::bigint[])';
        params.push(normalizedIds);
      }
      params.push(normalizedLimit);
      const [discoveredResult] = await conn.execute(
        `
          SELECT id,
                 storage_area AS "storageArea",
                 filename,
                 attempt_count AS "attemptCount"
          FROM media_local_cleanup
          ${idClause}
          ORDER BY updated_at, id
          LIMIT ?;
        `,
        params,
      );

      const discovered = readCleanupRows(discoveredResult);
      // Discover before taking tombstone row locks. Writers cancel tombstones
      // while holding the same candidate lock, so the opposite order deadlocks.
      const candidateIds = [
        ...new Set(
          discovered
            .filter((row) => row.storageArea === 'image')
            .map((row) => /^ingest-([1-9][0-9]*)-/.exec(row.filename)?.[1])
            .filter(Boolean),
        ),
      ].sort();
      for (const candidateId of candidateIds) {
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));', [`coderx:ingest-media:${candidateId}`]);
      }
      const [lockedResult] = discovered.length
        ? await conn.execute(
            `
        SELECT id, storage_area AS "storageArea", filename, attempt_count AS "attemptCount"
        FROM media_local_cleanup
        WHERE id = ANY(?::bigint[])
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED;
      `,
            [discovered.map((row) => Number(row.id))],
          )
        : [[], []];

      for (const row of readCleanupRows(lockedResult)) {
        summary.examined += 1;
        const entry = normalizeEntry(row);
        const root = this.roots[entry.storageArea];
        const localPath = path.resolve(root, entry.filename);
        if (path.dirname(localPath) !== root) {
          throw new TypeError('cleanup path escaped its configured root');
        }
        if (entry.storageArea === 'image' && /^ingest-[1-9][0-9]*-/.test(entry.filename)) {
          const [owners] = await conn.execute(
            `SELECT id FROM file
            WHERE ? IN (filename, regexp_replace(filename, '(\\.[^.]+)$', '-small\\1')) LIMIT 1;`,
            [entry.filename],
          );
          if (readRows(owners).length > 0) {
            await conn.execute('DELETE FROM media_local_cleanup WHERE id = ?;', [row.id]);
            continue;
          }
        }
        try {
          await this.fs.unlink(localPath);
          summary.deleted += 1;
          await conn.execute('DELETE FROM media_local_cleanup WHERE id = ?;', [row.id]);
        } catch (error) {
          if (errorProperty(error, 'code') === 'ENOENT') {
            summary.missing += 1;
            await conn.execute('DELETE FROM media_local_cleanup WHERE id = ?;', [row.id]);
            continue;
          }
          summary.failed += 1;
          summary.pendingIds.push(Number(row.id));
          await conn.execute(
            `
              UPDATE media_local_cleanup
              SET attempt_count = attempt_count + 1,
                  last_error = ?,
                  updated_at = clock_timestamp()
              WHERE id = ?;
            `,
            [String(errorProperty(error, 'message') || error || 'Local unlink failed').slice(0, 2000), row.id],
          );
        }
      }
      if (!borrowedConnection) await conn.commit();
      return summary;
    } catch (error) {
      if (!borrowedConnection) await conn.rollback();
      throw error;
    } finally {
      if (!borrowedConnection) conn.release();
    }
  }
}
