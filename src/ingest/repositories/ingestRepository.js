const DEFAULT_LOCK_KEY = 71920260724;

function createIngestRepository(database, options = {}) {
  const lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;

  async function syncSources(sources) {
    const sourceMap = new Map();
    const statement = `
      INSERT INTO ingest_source (
        source_key, name, feed_url, homepage_url, feed_type,
        content_mode, license_code, daily_limit, trust_score, enabled
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_key) DO UPDATE SET
        name = EXCLUDED.name,
        feed_url = EXCLUDED.feed_url,
        homepage_url = EXCLUDED.homepage_url,
        feed_type = EXCLUDED.feed_type,
        content_mode = EXCLUDED.content_mode,
        license_code = EXCLUDED.license_code,
        daily_limit = EXCLUDED.daily_limit,
        trust_score = EXCLUDED.trust_score,
        enabled = EXCLUDED.enabled,
        updated_at = clock_timestamp()
      RETURNING id;
    `;

    for (const source of sources) {
      const [result] = await database.execute(statement, [
        source.sourceKey,
        source.name,
        source.feedUrl,
        source.homepageUrl,
        source.feedType,
        source.contentMode,
        source.licenseCode,
        source.dailyLimit,
        source.trustScore,
        source.enabled,
      ]);
      sourceMap.set(source.sourceKey, {
        id: result.insertId,
        sourceKey: source.sourceKey,
      });
    }

    return sourceMap;
  }

  async function createRun({ triggerType = 'manual', runMode }) {
    const [result] = await database.execute(
      `
        INSERT INTO ingest_run (trigger_type, run_mode)
        VALUES (?, ?)
        RETURNING id;
      `,
      [triggerType, runMode],
    );
    return result.insertId;
  }

  async function finishRun(runId, { status, stats, errorMessage = null }) {
    const [result] = await database.execute(
      `
        UPDATE ingest_run
        SET status = ?,
            stats = ?::jsonb,
            error_message = ?,
            finished_at = clock_timestamp()
        WHERE id = ?;
      `,
      [status, JSON.stringify(stats || {}), errorMessage, runId],
    );
    return result;
  }

  async function upsertCandidates(sourceId, runId, candidates) {
    let inserted = 0;
    let duplicates = 0;
    const insertStatement = `
      INSERT INTO ingest_candidate (
        source_id, run_id, external_id, canonical_url, title_original,
        summary_original, author_original, source_published_at, content_mode,
        license_code, raw_payload, content_hash, score
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
      ON CONFLICT DO NOTHING
      RETURNING id;
    `;
    const refreshStatement = `
      UPDATE ingest_candidate
      SET run_id = ?,
          title_original = ?,
          summary_original = ?,
          author_original = ?,
          source_published_at = COALESCE(?, source_published_at),
          raw_payload = ?::jsonb,
          score = GREATEST(score, ?),
          last_seen_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE canonical_url = ?
         OR (source_id = ? AND external_id = ?)
         OR content_hash = ?;
    `;

    for (const candidate of candidates) {
      const [insertResult] = await database.execute(insertStatement, [
        sourceId,
        runId,
        candidate.externalId || null,
        candidate.canonicalUrl,
        candidate.titleOriginal,
        candidate.summaryOriginal || null,
        candidate.authorOriginal || null,
        candidate.sourcePublishedAt || null,
        candidate.contentMode,
        candidate.licenseCode,
        JSON.stringify(candidate.rawPayload || {}),
        candidate.contentHash || null,
        candidate.score,
      ]);

      if (insertResult.affectedRows > 0) {
        inserted += 1;
        continue;
      }

      await database.execute(refreshStatement, [
        runId,
        candidate.titleOriginal,
        candidate.summaryOriginal || null,
        candidate.authorOriginal || null,
        candidate.sourcePublishedAt || null,
        JSON.stringify(candidate.rawPayload || {}),
        candidate.score,
        candidate.canonicalUrl,
        sourceId,
        candidate.externalId || null,
        candidate.contentHash || null,
      ]);
      duplicates += 1;
    }

    return { inserted, duplicates };
  }

  async function listCandidates({ statuses = ['pending'], limit = 60 } = {}) {
    const safeStatuses = Array.isArray(statuses) && statuses.length > 0 ? statuses : ['pending'];
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 60;
    const [rows] = await database.execute(
      `
        SELECT
          c.id,
          c.external_id AS "externalId",
          c.canonical_url AS "canonicalUrl",
          c.title_original AS "titleOriginal",
          c.title_zh AS "titleZh",
          c.summary_original AS "summaryOriginal",
          c.summary_zh AS "summaryZh",
          c.recommendation,
          c.author_original AS "authorOriginal",
          c.source_published_at AS "sourcePublishedAt",
          c.content_mode AS "contentMode",
          c.license_code AS "licenseCode",
          c.content,
          c.score,
          c.status,
          s.id AS "sourceId",
          s.source_key AS "sourceKey",
          s.name AS "sourceName",
          s.daily_limit AS "dailyLimit"
        FROM ingest_candidate c
        JOIN ingest_source s ON s.id = c.source_id
        WHERE c.status = ANY(?::text[])
        ORDER BY c.score DESC, c.source_published_at DESC NULLS LAST, c.id ASC
        LIMIT ?;
      `,
      [safeStatuses, safeLimit],
    );
    return rows;
  }

  async function withAdvisoryLock(callback) {
    const connection = await database.getConnection();
    let acquired = false;

    try {
      const [rows] = await connection.execute('SELECT pg_try_advisory_lock(?) AS acquired;', [lockKey]);
      acquired = rows[0]?.acquired === true;
      if (!acquired) return { skipped: true };
      return await callback();
    } finally {
      try {
        if (acquired) {
          await connection.execute('SELECT pg_advisory_unlock(?) AS released;', [lockKey]);
        }
      } finally {
        connection.release();
      }
    }
  }

  return {
    createRun,
    finishRun,
    listCandidates,
    syncSources,
    upsertCandidates,
    withAdvisoryLock,
  };
}

module.exports = {
  createIngestRepository,
};
