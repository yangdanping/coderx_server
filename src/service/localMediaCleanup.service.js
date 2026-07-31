const fs = require('node:fs/promises');
const path = require('node:path');
const connection = require('@/app/database');
const { IMG_PATH, VIDEO_PATH } = require('@/constants/filePaths');

const STORAGE_AREAS = new Set(['image', 'video']);

function normalizeFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename !== filename.trim() || filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('cleanup filename must be a safe basename');
  }
  return filename;
}

function normalizeEntry(entry) {
  if (!STORAGE_AREAS.has(entry?.storageArea)) {
    throw new TypeError('cleanup storageArea must be image or video');
  }
  return {
    storageArea: entry.storageArea,
    filename: normalizeFilename(entry.filename),
  };
}

function smallImageFilename(filename) {
  const extension = path.extname(filename);
  return `${filename.slice(0, filename.length - extension.length)}-small${extension}`;
}

function buildLocalCleanupEntries(mediaRows = []) {
  const entries = [];
  for (const row of mediaRows) {
    if (row?.file_type === 'video') {
      if (row.filename) entries.push({ storageArea: 'video', filename: row.filename });
      if (row.poster) entries.push({ storageArea: 'video', filename: row.poster });
    } else if (row?.filename) {
      entries.push({ storageArea: 'image', filename: row.filename });
      entries.push({ storageArea: 'image', filename: smallImageFilename(row.filename) });
    }
  }
  const unique = new Map();
  for (const entry of entries.map(normalizeEntry)) {
    unique.set(`${entry.storageArea}:${entry.filename}`, entry);
  }
  return [...unique.values()];
}

function normalizeIds(ids) {
  if (ids == null) return null;
  if (!Array.isArray(ids)) throw new TypeError('cleanup ids must be an array');
  const normalized = Array.from(new Set(ids.map(Number)));
  if (normalized.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError('cleanup ids must contain positive safe integers');
  }
  return normalized;
}

class LocalMediaCleanupService {
  constructor({ database, fsPromises = fs, roots }) {
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

  async enqueueInTransaction(conn, entries) {
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
      ids.push(Number(result.insertId));
    }
    return ids;
  }

  async processPending({ ids = null, limit = 100 } = {}) {
    const normalizedIds = normalizeIds(ids);
    const normalizedLimit = Number(limit);
    if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit <= 0 || normalizedLimit > 1000) {
      throw new TypeError('cleanup limit must be an integer between 1 and 1000');
    }
    if (normalizedIds && normalizedIds.length === 0) {
      return { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
    }

    const conn = await this.database.getConnection();
    const summary = { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
    try {
      await conn.beginTransaction();
      const params = [];
      let idClause = '';
      if (normalizedIds) {
        idClause = 'WHERE id = ANY(?::bigint[])';
        params.push(normalizedIds);
      }
      params.push(normalizedLimit);
      const [rows] = await conn.execute(
        `
          SELECT id,
                 storage_area AS "storageArea",
                 filename,
                 attempt_count AS "attemptCount"
          FROM media_local_cleanup
          ${idClause}
          ORDER BY updated_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED;
        `,
        params,
      );

      for (const row of rows) {
        summary.examined += 1;
        const entry = normalizeEntry(row);
        const root = this.roots[entry.storageArea];
        const localPath = path.resolve(root, entry.filename);
        if (path.dirname(localPath) !== root) {
          throw new TypeError('cleanup path escaped its configured root');
        }
        try {
          await this.fs.unlink(localPath);
          summary.deleted += 1;
          await conn.execute('DELETE FROM media_local_cleanup WHERE id = ?;', [row.id]);
        } catch (error) {
          if (error?.code === 'ENOENT') {
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
            [String(error?.message || error || 'Local unlink failed').slice(0, 2000), row.id],
          );
        }
      }
      await conn.commit();
      return summary;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
}

const localMediaCleanupService = new LocalMediaCleanupService({
  database: connection,
  roots: { image: IMG_PATH, video: VIDEO_PATH },
});

module.exports = localMediaCleanupService;
module.exports.LocalMediaCleanupService = LocalMediaCleanupService;
module.exports.buildLocalCleanupEntries = buildLocalCleanupEntries;
