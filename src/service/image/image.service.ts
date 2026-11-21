import { readInsertedId } from '../../app/database/queryResult.js';
import BusinessError from '../../errors/BusinessError.js';
import type { ArticleCleanup, ArticleDatabase, ArticleTransaction, MediaRuntime } from '../article/article.types.js';
import { normalizePositiveId } from '../mediaImage/mediaImage.service.js';
import { buildAddImageFileSql, buildArticleImageDraftScope } from '../sql/image.sql.js';

type IdRow = { id: string | number };
type ImageRow = IdRow & { filename: string; file_type: string };
type MutationResult = { affectedRows: number };

interface ImageServiceOptions {
  database: ArticleDatabase;
  mediaRuntime: Pick<MediaRuntime, 'promotePublishedImages' | 'deleteR2ObjectsForFiles'>;
  localMediaCleanup: ArticleCleanup;
}

function normalizeImageIds(imageIds: unknown): number[] {
  if (!Array.isArray(imageIds)) {
    throw new BusinessError('参数错误: imageIds 必须是数组', 400);
  }
  const normalized = imageIds.map((id) => normalizePositiveId(id, 'imageId'));
  return Array.from(new Set(normalized));
}

/**
 * 图片服务层
 * 处理图片文件及其元数据的数据库操作
 */
export function createImageService({ database, mediaRuntime, localMediaCleanup }: ImageServiceOptions) {
  return new class ImageService {
    /**
     * 添加图片文件及其元数据
     * @param {number} userId - 用户ID
     * @param {string} filename - 文件名
     * @param {string} mimetype - MIME类型
     * @param {number} size - 文件大小
     * @param {number|null} width - 图片宽度
     * @param {number|null} height - 图片高度
     * @returns {Promise} 插入结果
     */
    addImage = async (
      userId: unknown, filename: string, mimetype: string, size: number,
      width: number | null = null, height: number | null = null,
      discardUncommittedUpload?: () => Promise<void>,
    ) => {
      let conn: ArticleTransaction | undefined;
      let transactionStarted = false;
      let commitAttempted = false;
      try {
        conn = await database.getConnection();
        await conn.beginTransaction();
        transactionStarted = true;

        const [fileResult] = await conn.execute(buildAddImageFileSql(), [userId, filename, mimetype, size]);
        const fileId = readInsertedId(fileResult);
        await conn.execute('INSERT INTO image_meta (file_id, width, height, is_cover) VALUES (?,?,?,FALSE);', [fileId, width, height]);
        commitAttempted = true;
        await conn.commit();
        return fileResult;
      } catch (error) {
        if (transactionStarted && conn) {
          try {
            await conn.rollback();
          } catch (rollbackError) {
            console.error('Image upload transaction rollback failed:', rollbackError);
          }
        }
        // A rejected COMMIT can mean only its acknowledgement was lost.
        if (!commitAttempted) {
          try {
            await discardUncommittedUpload?.();
          } catch {
            console.error('Image upload cleanup failed');
          }
        }
        throw error;
      } finally {
        conn?.release();
      }
    };

    /**
     * 根据文件名获取图片信息（包含元数据）
     * @param {string} filename - 文件名
     * @returns {Promise} 图片信息
     */
    getImageByFilename = async (filename: string) => {
      try {
        const statement = `
          SELECT
              f.*,
              im.is_cover,
              im.width,
              im.height
          FROM file f
          LEFT JOIN image_meta im ON f.id = im.file_id
          WHERE f.filename LIKE ? AND f.file_type = 'image'
          LIMIT 1;
        `;
        const [result] = await database.execute(statement, [`${filename}%`]);
        return (result as ImageRow[])[0];
      } catch (error) {
        console.error('getImageByFilename error:', error);
        throw error;
      }
    };

    /**
     * 关联图片到文章，并按显式传入的封面 ID 设置封面
     * @param {number} userId - 当前用户ID
     * @param {number} articleId - 文章ID
     * @param {Array<number>} imageIds - 图片ID数组
     * @param {number|null} coverImageId - 显式指定的封面图片ID；未传时不设置封面
     * @returns {Promise} 操作结果
     */
    updateImageArticle = async (userId: unknown, articleId: unknown, imageIds: unknown, coverImageId: unknown = null) => {
      const normalizedUserId = normalizePositiveId(userId, 'userId');
      const normalizedArticleId = normalizePositiveId(articleId, 'articleId');
      const uniqueImageIds = normalizeImageIds(imageIds);
      const normalizedCoverImageId = coverImageId == null ? null : normalizePositiveId(coverImageId, 'coverImageId');
      if (normalizedCoverImageId != null && !uniqueImageIds.includes(normalizedCoverImageId)) {
        throw new BusinessError('参数错误: 封面图片必须包含在已选图片中', 400);
      }

      const conn = await database.getConnection();
      let associatedImages: ImageRow[] = [];
      let response;
      try {
        await conn.beginTransaction();
        console.log('🔄 开始事务 - 更新文章图片关联');

        const [ownedArticles] = await conn.execute('SELECT id FROM article WHERE id = ? AND user_id = ? FOR UPDATE;', [normalizedArticleId, normalizedUserId]);
        if (!(ownedArticles as IdRow[])[0]) {
          throw new BusinessError('文章不存在或无权关联图片', 403);
        }

        const selectOldStatement = `
          SELECT id
          FROM file
          WHERE article_id = ?
            AND user_id = ?
            AND file_type = 'image'
          ORDER BY id;
        `;
        const [oldImages] = await conn.execute(selectOldStatement, [normalizedArticleId, normalizedUserId]);
        const oldImageIds = (oldImages as IdRow[]).map((image) => Number(image.id));
        const lockImageIds = Array.from(new Set([...oldImageIds, ...uniqueImageIds])).sort((left, right) => left - right);

        if (lockImageIds.length > 0) {
          const [lockedImages] = await conn.execute(
            `
              SELECT f.id
              FROM file f
              WHERE f.user_id = ?
                AND f.id = ANY(?::bigint[])
              ORDER BY f.id
              FOR UPDATE OF f;
            `,
            [normalizedUserId, lockImageIds],
          );
          if ((lockedImages as IdRow[]).length !== lockImageIds.length) {
            throw new BusinessError('部分图片不存在、无权访问或已被关联', 403);
          }
        }

        if (uniqueImageIds.length > 0) {
          const [selectedImages] = await conn.execute(
            `
              SELECT f.id
              FROM file f
              WHERE f.id = ANY(?::bigint[])
                AND f.user_id = ?
                AND f.file_type = 'image'
                AND (f.article_id IS NULL OR f.article_id = ?)
                AND ${buildArticleImageDraftScope()}
                AND NOT EXISTS (
                  SELECT 1
                  FROM flow_post_media fm
                  WHERE fm.file_id = f.id
                )
              ORDER BY f.id;
            `,
            [uniqueImageIds, normalizedUserId, normalizedArticleId, normalizedArticleId],
          );
          if ((selectedImages as IdRow[]).length !== uniqueImageIds.length) {
            throw new BusinessError('部分图片已被其他内容关联', 409);
          }
        }

        // 1. 清空当前用户在该文章中的图片封面标识
        const clearCoverStatement = `
          UPDATE image_meta AS im
          SET is_cover = FALSE
          FROM file AS f
          WHERE im.file_id = f.id
            AND f.article_id = ?
            AND f.user_id = ?
            AND f.file_type = 'image';
        `;
        await conn.execute(clearCoverStatement, [normalizedArticleId, normalizedUserId]);
        console.log('✅ 步骤1 - 清空旧封面标识');

        // 2. 原有图片 ID 已在统一加锁前读取
        console.log(`📋 步骤2 - 原有图片ID:`, oldImageIds);

        // 3. 将该文章的所有图片关联清空
        const clearArticleStatement = `
          UPDATE file
          SET article_id = NULL
          WHERE article_id = ?
            AND user_id = ?
            AND file_type = 'image';
        `;
        const [result3] = await conn.execute(clearArticleStatement, [normalizedArticleId, normalizedUserId]);
        console.log(`✅ 步骤3 - 清除原有关联: ${(result3 as MutationResult).affectedRows} 条记录`);

        // 4. 关联新的图片到该文章
        if (uniqueImageIds.length > 0) {
          const updateArticleStatement = `
            UPDATE file AS f
            SET article_id = ?, draft_id = NULL
            WHERE id = ANY(?::bigint[])
              AND user_id = ?
              AND file_type = 'image'
              AND (article_id IS NULL OR article_id = ?)
              AND ${buildArticleImageDraftScope()}
              AND NOT EXISTS (
                SELECT 1
                FROM flow_post_media fm
                WHERE fm.file_id = f.id
              );
          `;
          const [result4] = await conn.execute(updateArticleStatement, [normalizedArticleId, uniqueImageIds, normalizedUserId, normalizedArticleId, normalizedArticleId]);
          if ((result4 as MutationResult).affectedRows !== uniqueImageIds.length) {
            throw new BusinessError('部分图片已被其他内容关联', 409);
          }
          console.log(`✅ 步骤4 - 关联新图片: ${(result4 as MutationResult).affectedRows} 条记录`);
        }

        // 5. 设置封面图片
        if (normalizedCoverImageId) {
          const setCoverStatement = `
            UPDATE image_meta AS im
            SET is_cover = TRUE
            FROM file AS f
            WHERE im.file_id = f.id
              AND f.id = ?
              AND f.article_id = ?
              AND f.user_id = ?
              AND f.file_type = 'image';
          `;
          const [result5] = await conn.execute(setCoverStatement, [normalizedCoverImageId, normalizedArticleId, normalizedUserId]);
          console.log(`✅ 步骤5 - 设置封面: 图片ID ${normalizedCoverImageId}, 影响行数 ${(result5 as MutationResult).affectedRows}`);
        }

        // 6. 找出被删除的图片
        const deletedImageIds = oldImageIds.filter((id) => !uniqueImageIds.includes(id));
        if (deletedImageIds.length > 0) {
          console.log(`🗑️ 步骤6 - 检测到被删除的图片ID:`, deletedImageIds);
        }

        if (uniqueImageIds.length > 0) {
          const [rows] = await conn.execute(
            `
              SELECT id, filename, mimetype, size, file_type
              FROM file
              WHERE article_id = ?
                AND id = ANY(?::bigint[])
                AND user_id = ?
                AND file_type = 'image'
              ORDER BY id ASC;
            `,
            [normalizedArticleId, uniqueImageIds, normalizedUserId],
          );
          associatedImages = rows as ImageRow[];
        }

        await conn.commit();
        console.log('✅ 事务提交成功 - 图片关联更新完成');

        response = {
          success: true,
          affectedRows: uniqueImageIds.length,
          deletedCount: deletedImageIds.length,
          coverSet: !!normalizedCoverImageId,
        };
      } catch (error) {
        await conn.rollback();
        console.error('❌ 事务回滚 - 更新图片关联失败:', error);
        throw error;
      } finally {
        conn.release();
      }

      if (associatedImages.length > 0) {
        try {
          const promotion = await mediaRuntime.promotePublishedImages({
            articleId: normalizedArticleId,
            images: associatedImages,
          });
          const details = promotion as { attempted: unknown; ready: unknown; inProgress: unknown; failed: unknown; reason: unknown };
          console.log('☁️ 发布图片存储晋升结果:', {
            attempted: details.attempted,
            ready: details.ready,
            inProgress: details.inProgress,
            failed: details.failed,
            reason: details.reason,
          });
        } catch (error) {
          console.error('❌ 发布图片存储晋升失败，继续保留本地关联:', error instanceof Error ? error.message : error);
        }
      }

      return response;
    };

    /**
     * 删除当前用户尚未关联文章、草稿或 Flow 的图片。
     * 真正不存在的 ID 按幂等成功处理，任何仍存在但不满足删除条件的图片整批拒绝。
     * @param {number} userId - 当前用户ID
     * @param {Array<number>} imageIds - 图片ID数组
     * @returns {Promise<{result: Object, imagesToDelete: Array, localCleanup: Object}>}
     */
    deleteOwnedUnattachedImages = async (userId: unknown, imageIds: unknown) => {
      const normalizedUserId = normalizePositiveId(userId, 'userId');
      const uniqueImageIds = normalizeImageIds(imageIds);
      if (uniqueImageIds.length === 0) {
        return {
          result: { affectedRows: 0 },
          imagesToDelete: [],
          localCleanup: { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] },
        };
      }

      const conn = await database.getConnection();
      let deletionResult;
      let cleanupIds: number[] = [];
      try {
        await conn.beginTransaction();
        const [imageRows] = await conn.execute(
          `
            SELECT f.id, f.filename, f.file_type, f.user_id
            FROM file f
            LEFT JOIN flow_post_media fm ON fm.file_id = f.id
            WHERE f.id = ANY(?::bigint[])
              AND f.user_id = ?
              AND f.file_type = 'image'
              AND f.article_id IS NULL
              AND f.draft_id IS NULL
              AND fm.file_id IS NULL
            ORDER BY f.id
            FOR UPDATE OF f;
          `,
          [uniqueImageIds, normalizedUserId],
        );
        const imagesToDelete = imageRows as ImageRow[];
        const deletableIds = imagesToDelete.map((image) => Number(image.id));

        const [forbiddenImages] = await conn.execute(
          `
            SELECT f.id
            FROM file f
            WHERE f.id = ANY(?::bigint[])
              AND f.file_type = 'image'
              AND f.id <> ALL(?::bigint[])
            ORDER BY f.id;
          `,
          [uniqueImageIds, deletableIds],
        );
        if ((forbiddenImages as IdRow[]).length > 0) {
          throw new BusinessError('图片不可删除', 403);
        }

        if (deletableIds.length === 0) {
          await conn.commit();
          deletionResult = { result: { affectedRows: 0 }, imagesToDelete };
        } else {
          await mediaRuntime.deleteR2ObjectsForFiles(deletableIds);

          cleanupIds = await localMediaCleanup.enqueueInTransaction(conn, localMediaCleanup.buildLocalCleanupEntries(imagesToDelete));

          const [result] = await conn.execute(
            `
              DELETE FROM file
              WHERE id = ANY(?::bigint[])
                AND user_id = ?
                AND file_type = 'image'
                AND article_id IS NULL
                AND draft_id IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM flow_post_media fm
                  WHERE fm.file_id = file.id
                );
            `,
            [deletableIds, normalizedUserId],
          );
          if ((result as MutationResult).affectedRows !== deletableIds.length) {
            throw new Error('deleteOwnedUnattachedImages: not every locked image row was deleted');
          }

          await conn.commit();
          deletionResult = { result, imagesToDelete };
        }
      } catch (error) {
        await conn.rollback();
        console.error('deleteOwnedUnattachedImages error:', error);
        throw error;
      } finally {
        conn.release();
      }

      let localCleanup: Awaited<ReturnType<ArticleCleanup['processPending']>> = { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
      if (cleanupIds.length > 0) {
        try {
          localCleanup = await localMediaCleanup.processPending({ ids: cleanupIds });
        } catch (error) {
          console.error('deleteOwnedUnattachedImages local cleanup deferred for retry:', error instanceof Error ? error.message : error);
          localCleanup = { examined: 0, deleted: 0, missing: 0, failed: cleanupIds.length, pendingIds: cleanupIds };
        }
      }
      return { ...deletionResult, localCleanup };
    };

    /**
     * 获取文章的所有图片（包含元数据）
     * @param {number} articleId - 文章ID
     * @returns {Promise<Array>} 图片列表
     */
    getArticleImages = async (articleId: unknown) => {
      try {
        const statement = `
          SELECT
              f.id,
              f.filename,
              f.mimetype,
              f.size,
              im.is_cover,
              im.width,
              im.height
          FROM file f
          LEFT JOIN image_meta im ON f.id = im.file_id
          WHERE f.article_id = ? AND f.file_type = 'image'
          ORDER BY im.is_cover DESC, f.create_at ASC;
        `;
        const [result] = await database.execute(statement, [articleId]);
        return result as ImageRow[];
      } catch (error) {
        console.error('getArticleImages error:', error);
        throw error;
      }
    };
  };
}

export type ImageService = ReturnType<typeof createImageService>;
