import type { DatabaseAdapter } from '../../app/database/database.types.js';
import { readInsertedId } from '../../app/database/queryResult.js';
import type { Candidate, CandidateStatus, DatabaseId, FeedSource, NewCandidate } from '../ingest.types.js';
import type { buildArticleContent } from '../domain/buildArticleContent.js';
import { affectedRows, queryRows } from './queryResult.js';

const DEFAULT_LOCK_KEY = 71920260724;

function createIngestRepository(database: DatabaseAdapter, options: { lockKey?: number } = {}) {
  const lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;

  async function syncSources(sources: readonly FeedSource[]) {
    const sourceMap = new Map<string, { id: DatabaseId; sourceKey: string }>();
    const sourceKeys = sources.map((source) => source.sourceKey);
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

    await database.execute(
      `
        UPDATE ingest_source
        SET enabled = FALSE,
            updated_at = clock_timestamp()
        WHERE enabled = TRUE
          AND NOT (source_key = ANY(?::text[]));
      `,
      [sourceKeys],
    );

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
        id: readInsertedId(result),
        sourceKey: source.sourceKey,
      });
    }

    return sourceMap;
  }

  async function createRun({ triggerType = 'manual', runMode }: { triggerType?: string; runMode: string }) {
    const [result] = await database.execute(
      `
        INSERT INTO ingest_run (trigger_type, run_mode)
        VALUES (?, ?)
        RETURNING id;
      `,
      [triggerType, runMode],
    );
    return readInsertedId(result);
  }

  async function finishRun(runId: DatabaseId, { status, stats, errorMessage = null }: { status: 'succeeded' | 'failed'; stats: object; errorMessage?: string | null }) {
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

  async function upsertCandidates(sourceId: DatabaseId, runId: DatabaseId, candidates: readonly NewCandidate[]) {
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

      if ((affectedRows(insertResult) ?? 0) > 0) {
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

  async function listCandidates({ statuses = ['pending'], limit = 60 }: { statuses?: readonly CandidateStatus[]; limit?: number } = {}) {
    const safeStatuses = Array.isArray(statuses) && statuses.length > 0 ? statuses : ['pending'];
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 60;
    return await queryRows<Candidate>(
      database,
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
  }

  async function saveEnrichment(
    id: DatabaseId,
    { titleZh, summaryZh, recommendation, content }: { titleZh: string; summaryZh: string; recommendation: string; content: ReturnType<typeof buildArticleContent> },
  ) {
    const [result] = await database.execute(
      `
        UPDATE ingest_candidate
        SET title_zh = ?,
            summary_zh = ?,
            recommendation = ?,
            content = ?::jsonb,
            failure_reason = NULL,
            status = 'enriched',
            updated_at = clock_timestamp()
        WHERE id = ?;
      `,
      [titleZh, summaryZh, recommendation, JSON.stringify(content), id],
    );
    return result;
  }

  async function recordEnrichmentFailure(id: DatabaseId, message: string) {
    const [result] = await database.execute(
      `
        UPDATE ingest_candidate
        SET failure_reason = ?,
            status = 'pending',
            updated_at = clock_timestamp()
        WHERE id = ?;
      `,
      [message, id],
    );
    return result;
  }

  async function approveCandidates({ ids = [], limit = 10 }: { ids?: readonly number[]; limit?: number } = {}) {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const safeIds = Array.isArray(ids) ? [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))] : [];
    const idFilter = safeIds.length > 0 ? 'AND id = ANY(?::bigint[])' : '';
    const params = safeIds.length > 0 ? [safeIds, safeLimit] : [safeLimit];
    const [result] = await database.execute(
      `
        WITH selected AS (
          SELECT id
          FROM ingest_candidate
          WHERE status = 'enriched'
            ${idFilter}
          ORDER BY score DESC, source_published_at DESC NULLS LAST, id ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ingest_candidate AS candidate
        SET status = 'approved',
            failure_reason = NULL,
            updated_at = clock_timestamp()
        FROM selected
        WHERE candidate.id = selected.id;
      `,
      params,
    );
    return { approved: affectedRows(result) };
  }

  async function publishApproved({ authorName, tagName, limit = 10 }: { authorName: string; tagName: string; limit?: number }) {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const connection = await database.getConnection();

    try {
      await connection.beginTransaction();

      const authors = await queryRows<{ id: DatabaseId }>(
        connection,
        `
          SELECT id
          FROM "user"
          WHERE name = ? AND status = 0
          LIMIT 1;
        `,
        [authorName],
      );
      const author = authors[0];
      if (!author) throw new Error(`Publish author not found: ${authorName}`);

      const tags = await queryRows<{ id: DatabaseId }>(
        connection,
        `
          SELECT id
          FROM tag
          WHERE name = ?
          LIMIT 1;
        `,
        [tagName],
      );
      const tag = tags[0];
      if (!tag) throw new Error(`Publish tag not found: ${tagName}`);

      const candidates = await queryRows<
        Pick<Candidate, 'id' | 'sourceId' | 'canonicalUrl' | 'titleOriginal' | 'titleZh' | 'summaryZh' | 'sourcePublishedAt' | 'contentMode' | 'licenseCode' | 'content'>
      >(
        connection,
        `
          SELECT
            c.id,
            c.source_id AS "sourceId",
            c.canonical_url AS "canonicalUrl",
            c.title_original AS "titleOriginal",
            c.title_zh AS "titleZh",
            c.summary_zh AS "summaryZh",
            c.source_published_at AS "sourcePublishedAt",
            c.content_mode AS "contentMode",
            c.license_code AS "licenseCode",
            c.content
          FROM ingest_candidate c
          WHERE c.status = 'approved'
            AND c.article_id IS NULL
          ORDER BY c.score DESC, c.source_published_at DESC NULLS LAST, c.id ASC
          LIMIT ?
          FOR UPDATE OF c SKIP LOCKED;
        `,
        [safeLimit],
      );

      const articleIds = [];
      for (const candidate of candidates) {
        const [articleResult] = await connection.execute(
          `
            INSERT INTO article (user_id, title, content, excerpt)
            VALUES (?, ?, ?::jsonb, ?)
            RETURNING id;
          `,
          [author.id, candidate.titleZh, JSON.stringify(candidate.content), candidate.summaryZh],
        );
        const articleId = readInsertedId(articleResult);

        await connection.execute(
          `
            INSERT INTO article_tag (article_id, tag_id)
            VALUES (?, ?);
          `,
          [articleId, tag.id],
        );
        await connection.execute(
          `
            INSERT INTO article_source (
              article_id, candidate_id, source_id, canonical_url, source_title,
              source_published_at, content_mode, license_code
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
          `,
          [articleId, candidate.id, candidate.sourceId, candidate.canonicalUrl, candidate.titleOriginal, candidate.sourcePublishedAt, candidate.contentMode, candidate.licenseCode],
        );
        const [candidateResult] = await connection.execute(
          `
            UPDATE ingest_candidate
            SET article_id = ?,
                status = 'published',
                failure_reason = NULL,
                updated_at = clock_timestamp()
            WHERE id = ?
              AND status = 'approved'
              AND article_id IS NULL;
          `,
          [articleId, candidate.id],
        );
        if (affectedRows(candidateResult) !== 1) {
          throw new Error(`Candidate ${candidate.id} changed during publication`);
        }
        articleIds.push(articleId);
      }

      await connection.commit();
      return {
        published: articleIds.length,
        articleIds,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function withAdvisoryLock<Result>(callback: () => Result | Promise<Result>): Promise<Result | { skipped: true }> {
    const connection = await database.getConnection();
    let acquired = false;

    try {
      const rows = await queryRows<{ acquired: boolean }>(connection, 'SELECT pg_try_advisory_lock(?) AS acquired;', [lockKey]);
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
    approveCandidates,
    createRun,
    finishRun,
    listCandidates,
    publishApproved,
    recordEnrichmentFailure,
    saveEnrichment,
    syncSources,
    upsertCandidates,
    withAdvisoryLock,
  };
}

export { createIngestRepository };

export type IngestRepository = ReturnType<typeof createIngestRepository>;
