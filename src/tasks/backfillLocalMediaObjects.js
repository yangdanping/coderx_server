const { inspectLocalFile } = require('@/service/mediaPromotion.service');

function selectExistingStatement(lock = false) {
  return `
    SELECT
      id,
      local_path AS "localPath",
      size_bytes AS "sizeBytes",
      sha256,
      status
    FROM media_object
    WHERE file_id = ?
      AND provider = 'local'
      AND variant = ?
    ${lock ? 'FOR UPDATE' : ''};
  `;
}

function exactMatch(existing, candidate, inspected) {
  return (
    existing && existing.localPath === candidate.localPath && Number(existing.sizeBytes ?? existing.size_bytes) === inspected.sizeBytes && existing.sha256 === inspected.sha256
  );
}

function boundedFailure(candidate, error, code = 'LOCAL_MEDIA_BACKFILL_FAILED') {
  return {
    fileId: candidate.fileId,
    variant: candidate.variant,
    code,
    message: String(error?.message || error || code).slice(0, 500),
  };
}

async function registerCandidate(database, candidate, inspected) {
  const conn = await database.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(selectExistingStatement(true), [candidate.fileId, candidate.variant]);
    let existing = rows[0];
    if (!existing) {
      const [result] = await conn.execute(
        `
        INSERT INTO media_object (
          file_id,
          provider,
          variant,
          local_path,
          size_bytes,
          sha256,
          status,
          verified_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, clock_timestamp())
        ON CONFLICT DO NOTHING
        RETURNING id;
      `,
        [candidate.fileId, 'local', candidate.variant, candidate.localPath, inspected.sizeBytes, inspected.sha256, 'ready'],
      );
      if (result?.affectedRows === 1) {
        await conn.commit();
        return 'inserted';
      }
      const [winnerRows] = await conn.execute(selectExistingStatement(true), [candidate.fileId, candidate.variant]);
      existing = winnerRows[0];
    }
    if (!exactMatch(existing, candidate, inspected)) {
      const error = new Error(`Local media row for ${candidate.fileId}/${candidate.variant} contains different immutable content`);
      error.code = 'LOCAL_MEDIA_OBJECT_CONFLICT';
      throw error;
    }
    if (existing.status !== 'ready') {
      const [result] = await conn.execute(
        `
          UPDATE media_object
          SET status = 'ready',
              last_error = NULL,
              verified_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE id = ?;
        `,
        [existing.id],
      );
      if (result?.affectedRows !== 1) throw new Error('Local media row state repair did not affect exactly one row');
      await conn.commit();
      return 'repaired';
    }
    await conn.commit();
    return 'idempotent';
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function inspectDryRun(database, candidate, inspected) {
  if (typeof database.execute !== 'function') return 'wouldInsert';
  const [rows] = await database.execute(selectExistingStatement(false), [candidate.fileId, candidate.variant]);
  const existing = rows[0];
  if (!existing) return 'wouldInsert';
  if (!exactMatch(existing, candidate, inspected)) {
    const error = new Error(`Local media row for ${candidate.fileId}/${candidate.variant} contains different immutable content`);
    error.code = 'LOCAL_MEDIA_OBJECT_CONFLICT';
    throw error;
  }
  return existing.status === 'ready' ? 'idempotent' : 'wouldRepair';
}

async function backfillLocalMediaObjects({ catalog, database, inspector = inspectLocalFile, articleId, afterFileId = 0, limit = 1_000, dryRun = true } = {}) {
  if (!catalog || typeof catalog.listPublishedFiles !== 'function') throw new TypeError('catalog is required');
  if (!database || typeof database.getConnection !== 'function') throw new TypeError('database is required');
  if (typeof inspector !== 'function') throw new TypeError('inspector must be a function');
  const files = await catalog.listPublishedFiles({ articleId, afterFileId, limit });
  const discovered = await catalog.discoverVariants(files);
  const report = {
    dryRun: dryRun !== false,
    scope: 'published',
    examinedFiles: files.length,
    candidateObjects: discovered.candidates.length,
    candidateBytes: 0,
    wouldInsert: 0,
    wouldRepair: 0,
    inserted: 0,
    repaired: 0,
    idempotent: 0,
    failed: 0,
    missingAssets: discovered.missingAssets,
    invalidRows: discovered.invalidRows,
    failures: [],
    nextAfterFileId: files.length > 0 ? files.at(-1).id : Number(afterFileId || 0),
  };

  for (const candidate of discovered.candidates) {
    try {
      const inspected = await inspector(candidate.localPath);
      report.candidateBytes += inspected.sizeBytes;
      const outcome = report.dryRun ? await inspectDryRun(database, candidate, inspected) : await registerCandidate(database, candidate, inspected);
      report[outcome] += 1;
    } catch (error) {
      report.failed += 1;
      report.failures.push(boundedFailure(candidate, error, error?.code || 'LOCAL_MEDIA_BACKFILL_FAILED'));
    }
  }
  return report;
}

module.exports = {
  backfillLocalMediaObjects,
  registerCandidate,
};
