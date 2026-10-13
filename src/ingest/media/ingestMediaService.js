const { createMediaCatalog } = require('@/tasks/mediaCatalog');
const { registerCandidate } = require('@/tasks/backfillLocalMediaObjects');
const { inspectLocalFile, createMediaPromotionService } = require('@/service/mediaPromotion.service');
const { createMediaObjectService } = require('@/service/mediaObject.service');
const { createMediaDeletionService } = require('@/service/mediaDeletion.service');
const { createPublishedImagePromotionService } = require('@/service/publishedImagePromotion.service');
const { LocalMediaCleanupService, buildLocalCleanupEntries } = require('@/service/localMediaCleanup.service');

function positiveId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return id;
}
function failure(error) {
  return { code: error?.code || 'INGEST_MEDIA_SYNC_FAILED', message: String(error?.message || error).slice(0, 500) };
}

function createIngestMediaService({
  database,
  imageRoot,
  videoRoot = imageRoot,
  writeMode = 'local',
  writePaused = false,
  mutationsPaused = false,
  hardLimitBytes,
  r2Store,
  mediaPromotionService,
  inspector = inspectLocalFile,
  localCleanup = new LocalMediaCleanupService({ database, roots: { image: imageRoot, video: videoRoot } }),
}) {
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });
  const mediaObjects = createMediaObjectService({ database, hardLimitBytes });
  // Store is lazy in CLI. No R2 configuration or connection is needed in local mode.
  const promotion = createPublishedImagePromotionService({
    imageRoot,
    writeMode,
    writePaused,
    mediaPromotionService: mediaPromotionService || createMediaPromotionService({ mediaObjectService: mediaObjects, r2Store }),
  });
  const canMutateR2 = writeMode === 'r2_on_publish' && writePaused !== true && writePaused !== 'true';
  const deletion = r2Store ? createMediaDeletionService({ mediaObjectService: mediaObjects, r2Store }) : null;

  async function cleanupRetired(candidateIds) {
    const summary = { retired: 0, deferred: 0, deleted: 0, failures: [] };
    // Candidate locks match replacement and keep current/rebound rows out of deletion.
    for (const candidateId of candidateIds) {
      const conn = await database.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));', [`coderx:ingest-media:${candidateId}`]);
        const [rows] = await conn.execute(
          `
          SELECT f.id, f.filename, f.file_type,
                 EXISTS (SELECT 1 FROM media_object m WHERE m.file_id = f.id AND m.provider = 'r2') AS "hasR2"
          FROM file f
          WHERE f.article_id IS NULL AND f.draft_id IS NULL
            AND f.file_type = 'image' AND f.filename LIKE ?
            AND NOT EXISTS (SELECT 1 FROM flow_post_media fm WHERE fm.file_id = f.id)
          ORDER BY f.id
          FOR UPDATE OF f;
        `,
          [`ingest-${candidateId}-%`],
        );
        let deletedInTransaction = 0;
        for (const row of rows) {
          summary.retired += 1;
          if (row.hasR2 && (!canMutateR2 || !deletion)) {
            summary.deferred += 1;
            continue;
          }
          // Another file can own these local bytes. Never enqueue an unlink in that case.
          const [owners] = await conn.execute('SELECT id FROM file WHERE filename = ? AND id <> ? LIMIT 1;', [row.filename, row.id]);
          if (owners.length > 0) {
            summary.deferred += 1;
            continue;
          }
          if (row.hasR2) await deletion.deleteR2ObjectsForFiles([positiveId(row.id, 'fileId')]);
          await localCleanup.enqueueInTransaction(conn, buildLocalCleanupEntries([row]));
          const [removed] = await conn.execute(
            `DELETE FROM file WHERE id = ? AND article_id IS NULL AND draft_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM flow_post_media fm WHERE fm.file_id = file.id);`,
            [row.id],
          );
          if (removed.affectedRows !== 1) throw new Error(`Retired ingest file ${row.id} changed before deletion`);
          deletedInTransaction += 1;
        }
        await conn.commit();
        summary.deleted += deletedInTransaction;
        // Also recover tombstones left by a previous committed cleanup, scoped to
        // this candidate's immutable names; never drain unrelated cleanup work.
        await conn.beginTransaction();
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));', [`coderx:ingest-media:${candidateId}`]);
        const [pending] = await conn.execute(
          `SELECT id FROM media_local_cleanup
          WHERE storage_area = 'image' AND filename LIKE ?
            AND NOT EXISTS (SELECT 1 FROM file f WHERE media_local_cleanup.filename IN (f.filename,
              regexp_replace(f.filename, '(\\.[^.]+)$', '-small\\1')));`,
          [`ingest-${candidateId}-%`],
        );
        const processed = await localCleanup.processPending({ conn, ids: pending.map((row) => Number(row.id)), limit: Math.max(1, Math.min(pending.length, 1000)) });
        if (pending.length > processed.examined) summary.deferred += pending.length - processed.examined;
        await conn.commit();
        if (processed.failed > 0) summary.failures.push({ code: 'LOCAL_CLEANUP_RETRY_REQUIRED', message: `${processed.failed} local files require cleanup retry` });
      } catch (error) {
        await conn.rollback();
        summary.failures.push(failure(error));
      } finally {
        conn.release();
      }
    }
    return summary;
  }

  async function synchronizeArticle({ articleId }) {
    const id = positiveId(articleId, 'articleId');
    if (mutationsPaused === true || mutationsPaused === 'true') return { status: 'retry_required', reason: 'media_mutations_paused' };
    const [sources] = await database.execute('SELECT candidate_id AS "candidateId" FROM article_source WHERE article_id = ? ORDER BY candidate_id;', [id]);
    if (!sources.length) throw new Error(`Ingest article mapping not found: ${id}`);
    const candidateIds = sources.map((source) => positiveId(source.candidateId, 'candidateId'));
    const [images] = await database.execute(
      `SELECT f.id, f.article_id AS "articleId", f.filename, f.mimetype, f.file_type AS "fileType"
      FROM file f WHERE f.article_id = ? AND f.file_type = 'image' AND f.filename LIKE ANY(?::text[]) ORDER BY f.id;`,
      [id, candidateIds.map((candidateId) => `ingest-${candidateId}-%`)],
    );
    const discovered = await catalog.discoverVariants(images);
    const registration = {
      inserted: 0,
      repaired: 0,
      idempotent: 0,
      failed: 0,
      missingAssets: [...discovered.missingAssets, ...discovered.optionalMissingAssets],
      invalidRows: discovered.invalidRows,
      failures: [],
    };
    const incompleteIds = new Set([...registration.missingAssets, ...registration.invalidRows].map((row) => Number(row.fileId)));
    for (const candidate of discovered.candidates) {
      try {
        registration[await registerCandidate(database, candidate, await inspector(candidate.localPath))] += 1;
      } catch (error) {
        registration.failed += 1;
        registration.failures.push({ fileId: candidate.fileId, variant: candidate.variant, ...failure(error) });
        incompleteIds.add(candidate.fileId);
      }
    }
    const promoted = await promotion.promotePublishedImages({ articleId: id, images: images.filter((image) => !incompleteIds.has(Number(image.id))) });
    const cleanup = await cleanupRetired(candidateIds);
    const retry = !images.length || incompleteIds.size > 0 || promoted.failed > 0 || promoted.inProgress > 0 || cleanup.deferred > 0 || cleanup.failures.length > 0;
    return {
      status: retry ? 'retry_required' : promoted.enabled ? 'ready' : 'local_ready',
      reason: retry ? 'media_sync_incomplete' : promoted.reason,
      articleId: id,
      fileIds: images.map((image) => Number(image.id)),
      registration,
      promotion: promoted,
      cleanup,
    };
  }
  return { synchronizeArticle };
}
module.exports = { createIngestMediaService };
