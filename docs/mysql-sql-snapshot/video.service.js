const connection = require('@/app/database');
const SqlUtils = require('@/utils/SqlUtils');

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
      const fileStatement = `INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'video');`;
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
      const statement = `UPDATE video_meta vm INNER JOIN file f ON vm.file_id = f.id SET vm.poster = ? WHERE f.id = ?;`;
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
      const fields = [];
      const values = [];

      if (metadata.duration !== undefined) {
        fields.push('vm.duration = ?');
        values.push(metadata.duration);
      }
      if (metadata.width !== undefined) {
        fields.push('vm.width = ?');
        values.push(metadata.width);
      }
      if (metadata.height !== undefined) {
        fields.push('vm.height = ?');
        values.push(metadata.height);
      }
      if (metadata.bitrate !== undefined) {
        fields.push('vm.bitrate = ?');
        values.push(metadata.bitrate);
      }
      if (metadata.format !== undefined) {
        fields.push('vm.format = ?');
        values.push(metadata.format);
      }

      if (fields.length === 0) {
        return null;
      }

      values.push(videoId);
      const statement = `UPDATE video_meta vm INNER JOIN file f ON vm.file_id = f.id SET ${fields.join(', ')} WHERE f.id = ?;`;
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
      const statement = `UPDATE video_meta vm INNER JOIN file f ON vm.file_id = f.id SET vm.transcode_status = ? WHERE f.id = ?;`;
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
  updateVideoArticle = async (articleId, videoIds) => {
    const uniqueVideoIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      console.log('🔄 开始事务 - 更新文章视频关联');

      // 1. 查询该文章原有的视频ID
      const selectOldStatement = `SELECT id FROM file WHERE article_id = ? AND file_type = 'video';`;
      const [oldVideos] = await conn.execute(selectOldStatement, [articleId]);
      const oldVideoIds = oldVideos.map((video) => video.id);
      console.log(`📋 步骤1 - 原有视频ID:`, oldVideoIds);

      // 2. 将该文章的所有视频关联清空
      const clearArticleStatement = `UPDATE file SET article_id = NULL WHERE article_id = ? AND file_type = 'video';`;
      const [result2] = await conn.execute(clearArticleStatement, [articleId]);
      console.log(`✅ 步骤2 - 清除原有关联: ${result2.affectedRows} 条记录`);

      // 3. 关联新的视频到该文章
      if (uniqueVideoIds.length > 0) {
        const updateArticleStatement = `UPDATE file SET article_id = ? WHERE ${SqlUtils.queryIn('id', uniqueVideoIds)} AND file_type = 'video';`;
        const [result3] = await conn.execute(updateArticleStatement, [articleId, ...uniqueVideoIds]);
        console.log(`✅ 步骤3 - 关联新视频: ${result3.affectedRows} 条记录`);
      }

      // 4. 找出被删除的视频
      const deletedVideoIds = oldVideoIds.filter((id) => !uniqueVideoIds.includes(id));
      if (deletedVideoIds.length > 0) {
        console.log(`🗑️ 步骤4 - 检测到被删除的视频ID:`, deletedVideoIds);
      }

      await conn.commit();
      console.log('✅ 事务提交成功 - 视频关联更新完成');

      return {
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
  };

  /**
   * 根据ID删除视频（包含元数据和封面）
   * @param {Array<number>} videoIds - 视频ID数组
   * @returns {Promise} 删除结果
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   */
  deleteVideos = async (videoIds) => {
    if (!videoIds || videoIds.length === 0) return null;
    try {
      // 由于外键级联删除，只需删除 file 表记录，video_meta 会自动删除
      const statement = `DELETE FROM file WHERE ${SqlUtils.queryIn('id', videoIds)} AND file_type = 'video';`;
      const [result] = await connection.execute(statement, videoIds);
      return result;
    } catch (error) {
      console.error('deleteVideos error:', error);
      throw error;
    }
  };

  /**
   * 根据ID查询视频信息（用于删除物理文件）
   * @param {Array<number>} videoIds - 视频ID数组
   * @returns {Promise<Array>} 视频信息数组（包含poster）
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   */
  findVideosByIds = async (videoIds) => {
    if (!videoIds || videoIds.length === 0) return [];
    try {
      const statement = `
        SELECT f.filename, vm.poster
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE ${SqlUtils.queryIn('f.id', videoIds)} AND f.file_type = 'video';
      `;
      const [result] = await connection.execute(statement, videoIds);
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
          AND f.file_type
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
