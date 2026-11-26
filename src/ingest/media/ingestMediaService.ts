import type { DatabaseAdapter, SqlRow } from '../../app/database/database.types.js';
import type { DatabaseId } from '../ingest.types.js';
import type { MediaSynchronization } from '../pipeline/backfillRichArticles.js';
import { affectedRows, queryRows } from '../repositories/queryResult.js';
import { createMediaCatalog } from '../../tasks/mediaCatalog.js';
import { registerCandidate } from '../../tasks/backfillLocalMediaObjects.js';
import { inspectLocalFile, createMediaPromotionService } from '../../service/mediaPromotion.service.js';
import { createMediaObjectService } from '../../service/mediaObject.service.js';
import { createMediaDeletionService } from '../../service/mediaDeletion.service.js';
import { createPublishedImagePromotionService } from '../../service/publishedImagePromotion.service.js';
import { LocalMediaCleanupService, buildLocalCleanupEntries } from '../../service/localMediaCleanup.service.js';

function positiveId(value: unknown, name: string) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return id;
}
function failure(error: unknown) {
  const code: unknown = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const message: unknown = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  return { code: String(code || 'INGEST_MEDIA_SYNC_FAILED'), message: String(message || error).slice(0, 500) };
}

interface IngestMediaOptions {
  database: DatabaseAdapter;
  imageRoot: string;
  videoRoot?: string;
  writeMode?: string;
  writePaused?: boolean | string;
  mutationsPaused?: boolean | string;
  hardLimitBytes?: number;
  r2Store?: Parameters<typeof createMediaPromotionService>[0]['r2Store'] & Parameters<typeof createMediaDeletionService>[0]['r2Store'];
  mediaPromotionService?: Parameters<typeof createPublishedImagePromotionService>[0]['mediaPromotionService'];
  inspector?: typeof inspectLocalFile;
  localCleanup?: Pick<LocalMediaCleanupService, 'enqueueInTransaction' | 'processPending'>;
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
}: IngestMediaOptions) {
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });
  const mediaObjects = createMediaObjectService({ database, hardLimitBytes });
  // Store is lazy in CLI. No R2 configuration or connection is needed in local mode.
  const promoter = mediaPromotionService || (r2Store && createMediaPromotionService({ mediaObjectService: mediaObjects, r2Store }));
  if (!promoter) throw new TypeError('an injected r2Store is required');
  const promotion = createPublishedImagePromotionService({
    imageRoot,
    writeMode,
    writePaused,
    mediaPromotionService: promoter,
  });
  const canMutateR2 = writeMode === 'r2_on_publish' && writePaused !== true && writePaused !== 'true';
  const deletion = r2Store ? createMediaDeletionService({ mediaObjectService: mediaObjects, r2Store }) : null;

  async function cleanupRetired(candidateIds: readonly number[]) {
    const summary = { retired: 0, deferred: 0, deleted: 0, failures: [] as { code: string; message: string }[] };
    // Candidate locks match replacement and keep current/rebound rows out of deletion.
    for (const candidateId of candidateIds) {
      const conn = await database.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));', [`coderx:ingest-media:${candidateId}`]);
        const rows = await queryRows<{ id: DatabaseId; filename: string; file_type: string; hasR2: boolean }>(
          conn,
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
          const owners = await queryRows<{ id: DatabaseId }>(conn, 'SELECT id FROM file WHERE filename = ? AND id <> ? LIMIT 1;', [row.filename, row.id]);
          if (owners.length > 0) {
            summary.deferred += 1;
            continue;
          }
          if (row.hasR2 && deletion) await deletion.deleteR2ObjectsForFiles([positiveId(row.id, 'fileId')]);
          await localCleanup.enqueueInTransaction(conn, buildLocalCleanupEntries([row]));
          const [removed] = await conn.execute(
            `DELETE FROM file WHERE id = ? AND article_id IS NULL AND draft_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM flow_post_media fm WHERE fm.file_id = file.id);`,
            [row.id],
          );
          if (affectedRows(removed) !== 1) throw new Error(`Retired ingest file ${row.id} changed before deletion`);
          deletedInTransaction += 1;
        }
        await conn.commit();
        summary.deleted += deletedInTransaction;
        // Also recover tombstones left by a previous committed cleanup, scoped to
        // this candidate's immutable names; never drain unrelated cleanup work.
        await conn.beginTransaction();
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));', [`coderx:ingest-media:${candidateId}`]);
        const pending = await queryRows<{ id: DatabaseId }>(
          conn,
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

  async function synchronizeArticle({ articleId }: { articleId: DatabaseId }) {
    const id = positiveId(articleId, 'articleId');
    if (mutationsPaused === true || mutationsPaused === 'true') return { status: 'retry_required', reason: 'media_mutations_paused' } satisfies MediaSynchronization;
    const sources = await queryRows<{ candidateId: DatabaseId }>(database, 'SELECT candidate_id AS "candidateId" FROM article_source WHERE article_id = ? ORDER BY candidate_id;', [
      id,
    ]);
    if (!sources.length) throw new Error(`Ingest article mapping not found: ${id}`);
    const candidateIds = sources.map((source) => positiveId(source.candidateId, 'candidateId'));
    const images = await queryRows<SqlRow & { id: DatabaseId }>(
      database,
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
      failures: [] as (ReturnType<typeof failure> & { fileId: number; variant: string })[],
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
    } satisfies MediaSynchronization & { articleId: number; fileIds: number[]; registration: typeof registration; promotion: typeof promoted; cleanup: typeof cleanup };
  }
  return { synchronizeArticle };
}
export { createIngestMediaService };
