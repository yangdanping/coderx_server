import BusinessError from '../../errors/BusinessError.js';
import type { ArticleCleanup, ArticleDatabase, MediaRuntime } from '../article/article.types.js';
import { normalizePositiveId } from './mediaImage.service.js';

type PendingImageRow = {
  id: number | string;
  user_id: number | string;
  filename: string;
  file_type: string;
  article_id: number | string | null;
  draft_id: number | string | null;
  flow_id: number | string | null;
};
type MutationResult = { affectedRows: number };

interface MediaImageDeletionOptions {
  database: Pick<ArticleDatabase, 'getConnection'>;
  mediaRuntime: Pick<MediaRuntime, 'deleteR2ObjectsForFiles'>;
  localMediaCleanup: ArticleCleanup;
}

export function createMediaImageDeletionService(dependencies: MediaImageDeletionOptions) {
  return async function deletePendingImage(userId: unknown, mediaId: unknown) {
    const normalizedUserId = normalizePositiveId(userId, 'userId');
    const normalizedMediaId = normalizePositiveId(mediaId, 'mediaId');
    const conn = await dependencies.database.getConnection();
    let cleanupIds: number[] = [];

    try {
      await conn.beginTransaction();
      const [probeRows] = await conn.execute(
        `
          SELECT f.id,
                 f.user_id,
                 f.filename,
                 f.file_type,
                 f.article_id,
                 f.draft_id,
                 fm.flow_id
          FROM file f
          LEFT JOIN flow_post_media fm ON fm.file_id = f.id
          WHERE f.id = ?
            AND f.file_type = 'image';
        `,
        [normalizedMediaId],
      );
      const probe = (probeRows as PendingImageRow[])[0];
      if (!probe) {
        await conn.commit();
        return { deleted: false };
      }
      if (Number(probe.user_id) !== normalizedUserId) {
        throw new BusinessError('图片不可删除', 403);
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
        if (!(draftRows as unknown[])[0]) throw new BusinessError('图片不可删除', 403);
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
      const row = (lockedRows as PendingImageRow[])[0];
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
        if ((draftUpdateResult as MutationResult).affectedRows !== 1) {
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
      if ((deleteResult as MutationResult).affectedRows !== 1) {
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
        console.error('deletePendingImage local cleanup deferred for retry:', error instanceof Error ? error.message : error);
      }
    }
    return { deleted: true };
  };
}
