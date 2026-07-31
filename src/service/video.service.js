const connection = require('@/app/database');
const mediaRuntime = require('@/service/mediaRuntime.service');
const localMediaCleanup = require('@/service/localMediaCleanup.service');
const SqlUtils = require('@/utils/SqlUtils');
const BusinessError = require('@/errors/BusinessError');
const {
  buildAddVideoFileSql,
  buildVideoMetadataValues,
  buildUpdateTranscodeStatusSql,
  buildUpdateVideoMetadataSql,
  buildUpdateVideoPosterSql,
  buildVideoMetadataAssignments,
} = require('./sql/video.sql');

/**
 * 视频服务层
 * 处理视频文件及其元数据的数据库操作
 */
class VideoService {
  /**
   * 添加视频文件及其元数据
   * @param {number} userId - 用户ID
   * @param {string} filename - 文件名
   * @param {string} mimetype - MIME类型
   * @param {number} size - 文件大小
   * @param {Object} metadata - 视频元数据 {poster, duration, width, height, bitrate, format}
   * @returns {Promise} 插入结果
   */
  addVideo = async (userId, filename, mimetype, size, metadata = {}) => {
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 插入文件基础信息
      const fileStatement = buildAddVideoFileSql();
      const [fileResult] = await conn.execute(fileStatement, [userId, filename, mimetype, size]);
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

      await conn.commit();
      return fileResult;
    } catch (error) {
      await conn.rollback();
      console.error('addVideo error:', error);
      throw error;
    } finally {
      conn.release();
    }
  };

  /**
   * 根据文件名获取视频信息（包含元数据）
   * @param {string} filename - 文件名
   * @returns {Promise} 视频信息
   */
  getVideoByFilename = async (filename) => {
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
      const [result] = await connection.execute(statement, [filename]);
      return result[0];
    } catch (error) {
      console.error('getVideoByFilename error:', error);
      throw error;
    }
  };

  /**
   * 根据ID获取视频信息（包含元数据）
   * @param {number} videoId - 视频ID
   * @returns {Promise} 视频信息
   */
  getVideoById = async (videoId) => {
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
      const [result] = await connection.execute(statement, [videoId]);
      return result[0];
    } catch (error) {
      console.error('getVideoById error:', error);
      throw error;
    }
  };

  /**
   * 更新视频封面图
   * @param {number} videoId - 视频ID
   * @param {string} posterFilename - 封面文件名
   * @returns {Promise} 更新结果
   */
  updateVideoPoster = async (videoId, posterFilename) => {
    try {
      const statement = buildUpdateVideoPosterSql();
      const [result] = await connection.execute(statement, [posterFilename, videoId]);
      return result;
    } catch (error) {
      console.error('updateVideoPoster error:', error);
      throw error;
    }
  };

  /**
   * 更新视频元数据
   * @param {number} videoId - 视频ID
   * @param {Object} metadata - 元数据 {duration, width, height, bitrate, format}
   * @returns {Promise} 更新结果
   */
  updateVideoMetadata = async (videoId, metadata) => {
    try {
      const fields = buildVideoMetadataAssignments(metadata);
      const values = buildVideoMetadataValues(metadata);

      if (fields.length === 0) {
        return null;
      }

      values.push(videoId);
      const statement = buildUpdateVideoMetadataSql(fields);
      const [result] = await connection.execute(statement, values);
      return result;
    } catch (error) {
      console.error('updateVideoMetadata error:', error);
      throw error;
    }
  };

  /**
   * 更新视频转码状态
   * @param {number} videoId - 视频ID
   * @param {string} status - 转码状态 (pending/processing/completed/failed)
   * @returns {Promise} 更新结果
   */
  updateTranscodeStatus = async (videoId, status) => {
    try {
      const statement = buildUpdateTranscodeStatusSql();
      const [result] = await connection.execute(statement, [status, videoId]);
      return result;
    } catch (error) {
      console.error('updateTranscodeStatus error:', error);
      throw error;
    }
  };

  /**
   * 过滤合法的视频ID
   * @param {Array<number>} videoIds - 视频ID数组
   * @returns {Promise<Array<number>>} 合法视频ID数组
   */
  filterValidVideoIds = async (videoIds) => {
    if (!videoIds || videoIds.length === 0) return [];

    try {
      const statement = `SELECT id FROM file WHERE ${SqlUtils.queryIn('id', videoIds)} AND file_type = 'video';`;
      const [rows] = await connection.execute(statement, videoIds);
      return rows.map((item) => item.id);
    } catch (error) {
      console.error('filterValidVideoIds error:', error);
      throw error;
    }
  };

  /**
   * 关联视频到文章
   * @param {number} articleId - 文章ID
   * @param {Array<number>} videoIds - 视频ID数组
   * @returns {Promise} 操作结果
   */
  updateVideoArticle = async (articleId, videoIds, userId) => {
    const normalizedArticleId = Number(articleId);
    const normalizedUserId = Number(userId);
    if (!Number.isSafeInteger(normalizedArticleId) || normalizedArticleId <= 0 || !Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw new BusinessError('参数错误: articleId 和 userId 必须是正整数', 400);
    }
    const uniqueVideoIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    const conn = await connection.getConnection();
    let response;
    try {
      await conn.beginTransaction();
      console.log('🔄 开始事务 - 更新文章视频关联');

      const [ownedArticles] = await conn.execute('SELECT id FROM article WHERE id = ? AND user_id = ? FOR NO KEY UPDATE;', [normalizedArticleId, normalizedUserId]);
      if (!ownedArticles[0]) {
        throw new BusinessError('文章不存在或无权关联视频', 403);
      }

      // 1. 查询该文章原有的视频ID
      const selectOldStatement = `SELECT id FROM file WHERE article_id = ? AND file_type = 'video' ORDER BY id FOR NO KEY UPDATE;`;
      const [oldVideos] = await conn.execute(selectOldStatement, [normalizedArticleId]);
      const oldVideoIds = oldVideos.map((video) => video.id);
      console.log(`📋 步骤1 - 原有视频ID:`, oldVideoIds);

      let selectedVideos = [];
      if (uniqueVideoIds.length > 0) {
        [selectedVideos] = await conn.execute(
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
        if (selectedVideos.length !== uniqueVideoIds.length) {
          throw new BusinessError('部分视频不存在、无权访问或已关联其他文章', 403);
        }
      }

      // 2. 将该文章的所有视频关联清空
      const clearArticleStatement = `UPDATE file SET article_id = NULL WHERE article_id = ? AND file_type = 'video';`;
      const [result2] = await conn.execute(clearArticleStatement, [normalizedArticleId]);
      console.log(`✅ 步骤2 - 清除原有关联: ${result2.affectedRows} 条记录`);

      // 3. 关联新的视频到该文章
      if (uniqueVideoIds.length > 0) {
        const updateArticleStatement = `UPDATE file SET article_id = ?, draft_id = NULL WHERE id = ANY(?::bigint[]) AND file_type = 'video' AND user_id = ? AND (article_id IS NULL OR article_id = ?);`;
        const [result3] = await conn.execute(updateArticleStatement, [normalizedArticleId, uniqueVideoIds, normalizedUserId, normalizedArticleId]);
        if (result3.affectedRows !== uniqueVideoIds.length) {
          throw new Error('updateVideoArticle: not every locked video row was associated');
        }
        console.log(`✅ 步骤3 - 关联新视频: ${result3.affectedRows} 条记录`);
      }

      // 4. 找出被删除的视频
      const deletedVideoIds = oldVideoIds.filter((id) => !uniqueVideoIds.includes(id));
      if (deletedVideoIds.length > 0) {
        console.log(`🗑️ 步骤4 - 检测到被删除的视频ID:`, deletedVideoIds);
      }

      await conn.commit();
      console.log('✅ 事务提交成功 - 视频关联更新完成');

      response = {
        success: true,
        affectedRows: uniqueVideoIds.length,
        deletedCount: deletedVideoIds.length,
      };
    } catch (error) {
      await conn.rollback();
      console.error('❌ 事务回滚 - 更新视频关联失败:', error);
      throw error;
    } finally {
      conn.release();
    }

    if (uniqueVideoIds.length > 0) {
      try {
        const promotion = await this.promotePublishedVideoIds(uniqueVideoIds, normalizedArticleId);
        console.log('☁️ 发布视频存储晋升结果:', {
          attempted: promotion.attempted,
          ready: promotion.ready,
          inProgress: promotion.inProgress,
          failed: promotion.failed,
          skippedMissingAssets: promotion.skippedMissingAssets,
          completed: promotion.completed,
          reason: promotion.reason,
        });
      } catch (error) {
        console.error('❌ 发布视频存储晋升失败，继续保留本地关联:', error.message);
      }
    }

    return response;
  };

  /**
   * 晋升已完成且仍处于正式文章中的视频。FOR NO KEY UPDATE 与 media_object 的
   * 外键 KEY SHARE 兼容，但会阻塞解绑/删除 UPDATE，关闭陈旧 article key 的竞态窗口。
   */
  promotePublishedVideoIds = async (videoIds, expectedArticleId = null) => {
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

    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      const params = [normalizedVideoIds];
      const expectedArticleClause = normalizedExpectedArticleId == null ? '' : 'AND f.article_id = ?';
      if (normalizedExpectedArticleId != null) params.push(normalizedExpectedArticleId);
      const [videos] = await conn.execute(
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

      const grouped = new Map();
      for (const video of videos) {
        const articleVideos = grouped.get(Number(video.article_id)) || [];
        articleVideos.push(video);
        grouped.set(Number(video.article_id), articleVideos);
      }

      const total = {
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
        const result = await mediaRuntime.promotePublishedVideos({ articleId, videos: articleVideos });
        for (const field of ['attempted', 'ready', 'idempotent', 'inProgress', 'failed', 'completed', 'examined', 'eligible', 'skippedNotCompleted', 'skippedMissingAssets']) {
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

  /**
   * 根据ID删除视频（包含元数据和封面）
   * @param {Array<number>} videoIds - 视频ID数组
   * @param {number} userId - 必填，仅允许删除归属该用户的视频（防越权）
   * @returns {Promise} 删除结果
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   * 2. 强制按 user_id 过滤，作为控制器鉴权之外的数据库层兜底。
   */
  deleteVideos = async (videoIds, userId) => {
    if (!videoIds || videoIds.length === 0) return null;
    if (userId == null) {
      throw new Error('deleteVideos: userId 为必填，禁止无归属删除');
    }
    const normalizedVideoIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)));
    if (normalizedVideoIds.length !== videoIds.length) {
      throw new BusinessError('参数错误: videoIds 必须是有效且不重复的正整数数组', 400);
    }
    const conn = await connection.getConnection();
    let deletionResult;
    let cleanupIds = [];
    try {
      await conn.beginTransaction();
      const [videosToDelete] = await conn.execute(
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
      if (videosToDelete.length !== normalizedVideoIds.length) {
        throw new BusinessError('无权删除部分视频，或视频不存在', 403);
      }
      const processingVideo = videosToDelete.find((video) => ['pending', 'processing'].includes(video.transcode_status));
      if (processingVideo) {
        throw new BusinessError(`视频仍在处理中，请稍后重试删除（ID: ${processingVideo.id}）`, 409);
      }

      await mediaRuntime.deleteR2ObjectsForFiles(normalizedVideoIds);

      cleanupIds = await localMediaCleanup.enqueueInTransaction(conn, localMediaCleanup.buildLocalCleanupEntries(videosToDelete));

      const [result] = await conn.execute(`DELETE FROM file WHERE id = ANY(?::bigint[]) AND file_type = 'video' AND user_id = ?;`, [normalizedVideoIds, userId]);
      if (result.affectedRows !== normalizedVideoIds.length) {
        throw new Error('deleteVideos: not every locked video row was deleted');
      }

      await conn.commit();
      deletionResult = { result, videosToDelete };
    } catch (error) {
      await conn.rollback();
      console.error('deleteVideos error:', error);
      throw error;
    } finally {
      conn.release();
    }

    let localCleanup;
    try {
      localCleanup = await localMediaCleanup.processPending({ ids: cleanupIds });
    } catch (error) {
      console.error('deleteVideos local cleanup deferred for retry:', error.message);
      localCleanup = { examined: 0, deleted: 0, missing: 0, failed: cleanupIds.length, pendingIds: cleanupIds };
    }
    return { ...deletionResult, localCleanup };
  };

  /**
   * 根据ID查询视频信息（用于删除物理文件）
   * @param {Array<number>} videoIds - 视频ID数组
   * @param {number} userId - 必填，仅返回归属该用户的视频（防越权）
   * @returns {Promise<Array>} 视频信息数组（包含poster）
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   * 2. 强制按 user_id 过滤，保证调用方 diff 出 "不属于当前用户" 的 ID。
   */
  findVideosByIds = async (videoIds, userId) => {
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
      const [result] = await connection.execute(statement, [...videoIds, userId]);
      return result;
    } catch (error) {
      console.error('findVideosByIds error:', error);
      throw error;
    }
  };

  /**
   * 获取文章的所有视频（包含元数据）
   * @param {number} articleId - 文章ID
   * @returns {Promise<Array>} 视频列表
   */
  getArticleVideos = async (articleId) => {
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
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.error('getArticleVideos error:', error);
      throw error;
    }
  };
}

module.exports = new VideoService();
