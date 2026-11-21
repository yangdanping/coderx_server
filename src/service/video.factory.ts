import SqlUtils from '../utils/SqlUtils.js';
import BusinessError from '../errors/BusinessError.js';
import type { VideoAssociation, VideoFileRow, VideoLogger, VideoMetadata, VideoServiceDependencies, VideoStore } from './video.types.js';
import {
  buildAddVideoFileSql,
  buildVideoMetadataValues,
  buildUpdateTranscodeStatusSql,
  buildUpdateVideoMetadataSql,
  buildUpdateVideoPosterSql,
  buildVideoMetadataAssignments,
} from './sql/video.sql.js';

export class VideoUploadCommitError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/**
 * 视频服务层
 * 处理视频文件及其元数据的数据库操作
 */
type VideoIdRow = { id: number };
type PublishedVideoRow = VideoFileRow & { article_id: number | string; mimetype: string; size: number };
type InsertedVideo = { insertId: number };
type AffectedRows = { affectedRows: number };

// Statement-specific row types describe the selected columns without changing their DB representation.
function rows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new TypeError('Expected PostgreSQL video rows');
  return value as T[];
}

function insertedVideo(value: unknown): InsertedVideo {
  if (typeof value !== 'object' || value === null || !('insertId' in value) || typeof value.insertId !== 'number') {
    throw new TypeError('Video insert did not return a numeric id');
  }
  return value as InsertedVideo;
}

function mutation(value: unknown): AffectedRows {
  if (typeof value !== 'object' || value === null || !('affectedRows' in value) || typeof value.affectedRows !== 'number') {
    throw new TypeError('Video mutation did not return affectedRows');
  }
  return value as AffectedRows;
}

const promotionCounters = [
  'attempted', 'ready', 'idempotent', 'inProgress', 'failed', 'completed',
  'examined', 'eligible', 'skippedNotCompleted', 'skippedMissingAssets',
] as const;
type PromotionCounter = typeof promotionCounters[number];
type PromotionSummary = Record<PromotionCounter, number> & { reason?: unknown; failures?: unknown[] };

class VideoService implements VideoStore {
  readonly connection: VideoServiceDependencies['connection'];
  readonly mediaRuntime: VideoServiceDependencies['mediaRuntime'];
  readonly localMediaCleanup: VideoServiceDependencies['localMediaCleanup'];
  readonly logger: VideoLogger;

  constructor({ connection, mediaRuntime, localMediaCleanup, logger = console }: VideoServiceDependencies) {
    this.connection = connection;
    this.mediaRuntime = mediaRuntime;
    this.localMediaCleanup = localMediaCleanup;
    this.logger = logger;
  }

  addVideo = async (userId: unknown, filename: string, mimetype: string, size: number, metadata: Partial<VideoMetadata> & { poster?: string | null } = {}) => {
    const conn = await this.connection.getConnection();
    let commitAttempted = false;
    try {
      await conn.beginTransaction();

      // 1. 插入文件基础信息
      const fileStatement = buildAddVideoFileSql();
      const [insert] = await conn.execute(fileStatement, [userId, filename, mimetype, size]);
      const fileResult = insertedVideo(insert);
      const fileId = fileResult.insertId;

      // 2. 插入视频元数据
      const { poster = null, duration = null, width = null, height = null, bitrate = null, format = null } = metadata;
      const metaStatement = `
        INSERT INTO video_meta
            (file_id, poster, duration, width, height, bitrate, format, transcode_status)
        VALUES
            (?, ?, ?, ?, ?, ?, ?, 'pending');
      `;
      await conn.execute(metaStatement, [fileId, poster, duration, width, height, bitrate, format]);

      commitAttempted = true;
      await conn.commit();
      return fileResult;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        this.logger.error('addVideo rollback error:', rollbackError);
      }
      this.logger.error('addVideo error:', error);
      // A lost COMMIT acknowledgement does not prove PostgreSQL rolled back.
      if (commitAttempted) throw new VideoUploadCommitError(error);
      throw error;
    } finally {
      conn.release();
    }
  };

  getVideoByFilename = async (filename: string) => {
    try {
      const statement = `
        SELECT
            f.*,
            vm.poster,
            vm.duration,
            vm.width,
            vm.height,
            vm.bitrate,
            vm.format,
            vm.transcode_status
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE f.filename = ? AND f.file_type = 'video'
        LIMIT 1;
      `;
      const [result] = await this.connection.execute(statement, [filename]);
      return rows<VideoFileRow>(result)[0];
    } catch (error) {
      this.logger.error('getVideoByFilename error:', error);
      throw error;
    }
  };

  getVideoById = async (videoId: number | string) => {
    try {
      const statement = `
        SELECT
            f.*,
            vm.poster,
            vm.duration,
            vm.width,
            vm.height,
            vm.bitrate,
            vm.format,
            vm.transcode_status
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE f.id = ? AND f.file_type = 'video'
        LIMIT 1;
      `;
      const [result] = await this.connection.execute(statement, [videoId]);
      return rows<VideoFileRow>(result)[0];
    } catch (error) {
      this.logger.error('getVideoById error:', error);
      throw error;
    }
  };

  updateVideoPoster = async (videoId: number, posterFilename: string) => {
    try {
      const statement = buildUpdateVideoPosterSql();
      const [result] = await this.connection.execute(statement, [posterFilename, videoId]);
      return result;
    } catch (error) {
      this.logger.error('updateVideoPoster error:', error);
      throw error;
    }
  };

  updateVideoMetadata = async (videoId: number, metadata: Partial<VideoMetadata>) => {
    try {
      const fields = buildVideoMetadataAssignments(metadata);
      const values = buildVideoMetadataValues(metadata);

      if (fields.length === 0) {
        return null;
      }

      values.push(videoId);
      const statement = buildUpdateVideoMetadataSql(fields);
      const [result] = await this.connection.execute(statement, values);
      return result;
    } catch (error) {
      this.logger.error('updateVideoMetadata error:', error);
      throw error;
    }
  };

  updateTranscodeStatus = async (videoId: number, status: Parameters<VideoStore['updateTranscodeStatus']>[1]) => {
    try {
      const statement = buildUpdateTranscodeStatusSql();
      const [result] = await this.connection.execute(statement, [status, videoId]);
      return result;
    } catch (error) {
      this.logger.error('updateTranscodeStatus error:', error);
      throw error;
    }
  };

  filterValidVideoIds = async (videoIds: number[] | null | undefined) => {
    if (!videoIds || videoIds.length === 0) return [];

    try {
      const statement = `SELECT id FROM file WHERE ${SqlUtils.queryIn('id', videoIds)} AND file_type = 'video';`;
      const [result] = await this.connection.execute(statement, videoIds);
      return rows<VideoIdRow>(result).map(item => item.id);
    } catch (error) {
      this.logger.error('filterValidVideoIds error:', error);
      throw error;
    }
  };

  updateVideoArticle = async (articleId: number | string, videoIds: number[], userId: unknown): Promise<VideoAssociation> => {
    const normalizedArticleId = Number(articleId);
    const normalizedUserId = Number(userId);
    if (!Number.isSafeInteger(normalizedArticleId) || normalizedArticleId <= 0 || !Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw new BusinessError('参数错误: articleId 和 userId 必须是正整数', 400);
    }
    const uniqueVideoIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    const conn = await this.connection.getConnection();
    let response: VideoAssociation;
    try {
      await conn.beginTransaction();
      this.logger.info('🔄 开始事务 - 更新文章视频关联');

      const [ownedArticles] = await conn.execute('SELECT id FROM article WHERE id = ? AND user_id = ? FOR NO KEY UPDATE;', [normalizedArticleId, normalizedUserId]);
      if (!rows<VideoIdRow>(ownedArticles)[0]) {
        throw new BusinessError('文章不存在或无权关联视频', 403);
      }

      // 1. 查询该文章原有的视频ID
      const selectOldStatement = `SELECT id FROM file WHERE article_id = ? AND file_type = 'video' ORDER BY id FOR NO KEY UPDATE;`;
      const [oldVideos] = await conn.execute(selectOldStatement, [normalizedArticleId]);
      const oldVideoIds = rows<VideoIdRow>(oldVideos).map(video => video.id);
      this.logger.info(`📋 步骤1 - 原有视频ID:`, oldVideoIds);

      if (uniqueVideoIds.length > 0) {
        const [selectedVideos] = await conn.execute(
          `
            SELECT id
            FROM file
            WHERE id = ANY(?::bigint[])
              AND file_type = 'video'
              AND user_id = ?
              AND (article_id IS NULL OR article_id = ?)
            ORDER BY id
            FOR NO KEY UPDATE;
          `,
          [uniqueVideoIds, normalizedUserId, normalizedArticleId],
        );
        if (rows<VideoIdRow>(selectedVideos).length !== uniqueVideoIds.length) {
          throw new BusinessError('部分视频不存在、无权访问或已关联其他文章', 403);
        }
      }

      // 2. 将该文章的所有视频关联清空
      const clearArticleStatement = `UPDATE file SET article_id = NULL WHERE article_id = ? AND file_type = 'video';`;
      const [result2] = await conn.execute(clearArticleStatement, [normalizedArticleId]);
      this.logger.info(`✅ 步骤2 - 清除原有关联: ${mutation(result2).affectedRows} 条记录`);

      // 3. 关联新的视频到该文章
      if (uniqueVideoIds.length > 0) {
        const updateArticleStatement = `UPDATE file SET article_id = ?, draft_id = NULL WHERE id = ANY(?::bigint[]) AND file_type = 'video' AND user_id = ? AND (article_id IS NULL OR article_id = ?);`;
        const [association] = await conn.execute(updateArticleStatement, [normalizedArticleId, uniqueVideoIds, normalizedUserId, normalizedArticleId]);
        const result3 = mutation(association);
        if (result3.affectedRows !== uniqueVideoIds.length) {
          throw new Error('updateVideoArticle: not every locked video row was associated');
        }
        this.logger.info(`✅ 步骤3 - 关联新视频: ${result3.affectedRows} 条记录`);
      }

      // 4. 找出被删除的视频
      const deletedVideoIds = oldVideoIds.filter((id) => !uniqueVideoIds.includes(id));
      if (deletedVideoIds.length > 0) {
        this.logger.info(`🗑️ 步骤4 - 检测到被删除的视频ID:`, deletedVideoIds);
      }

      await conn.commit();
      this.logger.info('✅ 事务提交成功 - 视频关联更新完成');

      response = {
        success: true,
        affectedRows: uniqueVideoIds.length,
        deletedCount: deletedVideoIds.length,
      };
    } catch (error) {
      await conn.rollback();
      this.logger.error('❌ 事务回滚 - 更新视频关联失败:', error);
      throw error;
    } finally {
      conn.release();
    }

    if (uniqueVideoIds.length > 0) {
      try {
        const promotion = await this.promotePublishedVideoIds(uniqueVideoIds, normalizedArticleId);
        this.logger.info('☁️ 发布视频存储晋升结果:', {
          attempted: promotion.attempted,
          ready: promotion.ready,
          inProgress: promotion.inProgress,
          failed: promotion.failed,
          skippedMissingAssets: promotion.skippedMissingAssets,
          completed: promotion.completed,
          reason: promotion.reason,
        });
      } catch (error) {
        this.logger.error('❌ 发布视频存储晋升失败，继续保留本地关联:', error instanceof Error ? error.message : String(error));
      }
    }

    return response;
  };

  /**
   * 晋升已完成且仍处于正式文章中的视频。FOR NO KEY UPDATE 与 media_object 的
   * 外键 KEY SHARE 兼容，但会阻塞解绑/删除 UPDATE，关闭陈旧 article key 的竞态窗口。
   */
  promotePublishedVideoIds = async (videoIds: number[] | null | undefined, expectedArticleId: number | string | null = null): Promise<PromotionSummary> => {
    const normalizedVideoIds = Array.from(new Set((videoIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
    if (normalizedVideoIds.length === 0) {
      return {
        attempted: 0,
        ready: 0,
        idempotent: 0,
        inProgress: 0,
        failed: 0,
        completed: 0,
        examined: 0,
        eligible: 0,
        skippedNotCompleted: 0,
        skippedMissingAssets: 0,
        reason: 'no_published_completed_video',
      };
    }
    const normalizedExpectedArticleId = expectedArticleId == null ? null : Number(expectedArticleId);
    if (normalizedExpectedArticleId != null && (!Number.isSafeInteger(normalizedExpectedArticleId) || normalizedExpectedArticleId <= 0)) {
      throw new BusinessError('参数错误: expectedArticleId 必须是正整数', 400);
    }

    const conn = await this.connection.getConnection();
    try {
      await conn.beginTransaction();
      const params: unknown[] = [normalizedVideoIds];
      const expectedArticleClause = normalizedExpectedArticleId == null ? '' : 'AND f.article_id = ?';
      if (normalizedExpectedArticleId != null) params.push(normalizedExpectedArticleId);
      const [published] = await conn.execute(
        `
          SELECT f.id,
                 f.article_id,
                 f.filename,
                 f.mimetype,
                 f.size,
                 vm.poster,
                 vm.transcode_status
          FROM file f
          JOIN video_meta vm ON f.id = vm.file_id
          WHERE f.id = ANY(?::bigint[])
            AND f.file_type = 'video'
            AND f.article_id IS NOT NULL
            AND vm.transcode_status = 'completed'
            ${expectedArticleClause}
          ORDER BY f.id
          FOR NO KEY UPDATE OF f;
        `,
        params,
      );

      const videos = rows<PublishedVideoRow>(published);
      const grouped = new Map<number, PublishedVideoRow[]>();
      for (const video of videos) {
        const articleVideos = grouped.get(Number(video.article_id)) || [];
        articleVideos.push(video);
        grouped.set(Number(video.article_id), articleVideos);
      }

      const total: PromotionSummary & { failures: unknown[] } = {
        attempted: 0,
        ready: 0,
        idempotent: 0,
        inProgress: 0,
        failed: 0,
        completed: 0,
        examined: 0,
        eligible: 0,
        skippedNotCompleted: 0,
        skippedMissingAssets: 0,
        failures: [],
      };
      for (const [articleId, articleVideos] of grouped) {
        const summary = await this.mediaRuntime.promotePublishedVideos({ articleId, videos: articleVideos });
        if (typeof summary !== 'object' || summary === null) throw new TypeError('Expected video promotion summary');
        const result = summary as Partial<Record<PromotionCounter | 'failures' | 'reason', unknown>>;
        for (const field of promotionCounters) {
          total[field] += Number(result[field] || 0);
        }
        if (Array.isArray(result.failures)) total.failures.push(...result.failures);
        if (result.reason) total.reason = result.reason;
      }
      if (videos.length === 0) total.reason = 'no_published_completed_video';
      await conn.commit();
      return total;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  };

  deleteVideos = async (videoIds: number[] | null | undefined, userId: unknown) => {
    if (!videoIds || videoIds.length === 0) return null;
    if (userId == null) {
      throw new Error('deleteVideos: userId 为必填，禁止无归属删除');
    }
    const normalizedVideoIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)));
    if (normalizedVideoIds.length !== videoIds.length) {
      throw new BusinessError('参数错误: videoIds 必须是有效且不重复的正整数数组', 400);
    }
    const conn = await this.connection.getConnection();
    let deletionResult;
    let cleanupIds: number[];
    try {
      await conn.beginTransaction();
      const [toDelete] = await conn.execute(
        `
          SELECT f.id, f.filename, f.file_type, f.user_id, vm.poster, vm.transcode_status
          FROM file f
          LEFT JOIN video_meta vm ON f.id = vm.file_id
          WHERE f.id = ANY(?::bigint[])
            AND f.file_type = 'video'
            AND f.user_id = ?
          ORDER BY f.id ASC
          FOR UPDATE OF f;
        `,
        [normalizedVideoIds, userId],
      );
      const videosToDelete = rows<VideoFileRow>(toDelete);
      if (videosToDelete.length !== normalizedVideoIds.length) {
        throw new BusinessError('无权删除部分视频，或视频不存在', 403);
      }
      const processingVideo = videosToDelete.find((video) => video.transcode_status === 'pending' || video.transcode_status === 'processing');
      if (processingVideo) {
        throw new BusinessError(`视频仍在处理中，请稍后重试删除（ID: ${processingVideo.id}）`, 409);
      }

      await this.mediaRuntime.deleteR2ObjectsForFiles(normalizedVideoIds);

      cleanupIds = await this.localMediaCleanup.enqueueInTransaction(conn, this.localMediaCleanup.buildLocalCleanupEntries(videosToDelete));

      const [result] = await conn.execute(`DELETE FROM file WHERE id = ANY(?::bigint[]) AND file_type = 'video' AND user_id = ?;`, [normalizedVideoIds, userId]);
      if (mutation(result).affectedRows !== normalizedVideoIds.length) {
        throw new Error('deleteVideos: not every locked video row was deleted');
      }

      await conn.commit();
      deletionResult = { result, videosToDelete };
    } catch (error) {
      await conn.rollback();
      this.logger.error('deleteVideos error:', error);
      throw error;
    } finally {
      conn.release();
    }

    let localCleanup;
    try {
      localCleanup = await this.localMediaCleanup.processPending({ ids: cleanupIds });
    } catch (error) {
      this.logger.error('deleteVideos local cleanup deferred for retry:', error instanceof Error ? error.message : String(error));
      localCleanup = { examined: 0, deleted: 0, missing: 0, failed: cleanupIds.length, pendingIds: cleanupIds };
    }
    return { ...deletionResult, localCleanup };
  };

  findVideosByIds = async (videoIds: number[] | null | undefined, userId: unknown) => {
    if (!videoIds || videoIds.length === 0) return [];
    if (userId == null) {
      throw new Error('findVideosByIds: userId 为必填，禁止跨用户查询');
    }
    try {
      const statement = `
        SELECT f.id, f.filename, f.user_id, vm.poster
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE ${SqlUtils.queryIn('f.id', videoIds)}
          AND f.file_type = 'video'
          AND f.user_id = ?;
      `;
      const [result] = await this.connection.execute(statement, [...videoIds, userId]);
      return rows<VideoFileRow>(result);
    } catch (error) {
      this.logger.error('findVideosByIds error:', error);
      throw error;
    }
  };

  getArticleVideos = async (articleId: number | string) => {
    try {
      const statement = `
        SELECT f.id,
              f.filename,
              f.mimetype,
              f.size,
              vm.poster,
              vm.duration,
              vm.width,
              vm.height,
              vm.bitrate,
              vm.format,
              vm.transcode_status
        FROM file f
                LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE f.article_id = ?
          AND f.file_type = 'video';
      `;
      const [result] = await this.connection.execute(statement, [articleId]);
      return rows<VideoFileRow>(result);
    } catch (error) {
      this.logger.error('getArticleVideos error:', error);
      throw error;
    }
  };
}

export function createVideoService(dependencies: VideoServiceDependencies) {
  return new VideoService(dependencies);
}
