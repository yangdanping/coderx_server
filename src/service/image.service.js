const connection = require('@/app/database');
const SqlUtils = require('@/utils/SqlUtils');
const { buildAddImageFileSql, buildClearImageCoverSql, buildSetImageCoverSql } = require('./sql/image.sql');

/**
 * 图片服务层
 * 处理图片文件及其元数据的数据库操作
 */
class ImageService {
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
  addImage = async (userId, filename, mimetype, size, width = null, height = null) => {
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 插入文件基础信息
      const fileStatement = buildAddImageFileSql();
      const [fileResult] = await conn.execute(fileStatement, [userId, filename, mimetype, size]);
      const fileId = fileResult.insertId;

      // 2. 插入图片元数据
      const metaStatement = `INSERT INTO image_meta (file_id, width, height, is_cover) VALUES (?,?,?,FALSE);`;
      await conn.execute(metaStatement, [fileId, width, height]);

      await conn.commit();
      return fileResult;
    } catch (error) {
      await conn.rollback();
      console.error('addImage error:', error);
      throw error;
    } finally {
      conn.release();
    }
  };

  /**
   * 根据文件名获取图片信息（包含元数据）
   * @param {string} filename - 文件名
   * @returns {Promise} 图片信息
   */
  getImageByFilename = async (filename) => {
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
      const [result] = await connection.execute(statement, [`${filename}%`]);
      return result[0];
    } catch (error) {
      console.error('getImageByFilename error:', error);
      throw error;
    }
  };

  /**
   * 关联图片到文章，并按显式传入的封面 ID 设置封面
   * @param {number} articleId - 文章ID
   * @param {Array<number>} imageIds - 图片ID数组
   * @param {number|null} coverImageId - 显式指定的封面图片ID；未传时不设置封面
   * @returns {Promise} 操作结果
   */
  updateImageArticle = async (articleId, imageIds, coverImageId = null) => {
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      console.log('🔄 开始事务 - 更新文章图片关联');

      // 1. 清空该文章所有图片的封面标识
      const clearCoverStatement = buildClearImageCoverSql();
      await conn.execute(clearCoverStatement, [articleId]);
      console.log('✅ 步骤1 - 清空旧封面标识');

      // 2. 查询该文章原有的图片ID
      const selectOldStatement = `
        SELECT id
        FROM file
        WHERE article_id = ? AND file_type = 'image';
      `;
      const [oldImages] = await conn.execute(selectOldStatement, [articleId]);
      const oldImageIds = oldImages.map((img) => img.id);
      console.log(`📋 步骤2 - 原有图片ID:`, oldImageIds);

      // 3. 将该文章的所有图片关联清空
      const clearArticleStatement = `
        UPDATE file
        SET article_id = NULL
        WHERE article_id = ? AND file_type = 'image';
      `;
      const [result3] = await conn.execute(clearArticleStatement, [articleId]);
      console.log(`✅ 步骤3 - 清除原有关联: ${result3.affectedRows} 条记录`);

      // 4. 关联新的图片到该文章
      if (imageIds.length > 0) {
        const updateArticleStatement = `
          UPDATE file
          SET article_id = ?, draft_id = NULL
          WHERE ${SqlUtils.queryIn('id', imageIds)} AND file_type = 'image';
        `;
        const [result4] = await conn.execute(updateArticleStatement, [articleId, ...imageIds]);
        console.log(`✅ 步骤4 - 关联新图片: ${result4.affectedRows} 条记录`);
      }

      // 5. 设置封面图片
      if (coverImageId) {
        const setCoverStatement = buildSetImageCoverSql();
        const [result5] = await conn.execute(setCoverStatement, [coverImageId, articleId]);
        console.log(`✅ 步骤5 - 设置封面: 图片ID ${coverImageId}, 影响行数 ${result5.affectedRows}`);
      }

      // 6. 找出被删除的图片
      const deletedImageIds = oldImageIds.filter((id) => !imageIds.includes(id));
      if (deletedImageIds.length > 0) {
        console.log(`🗑️ 步骤6 - 检测到被删除的图片ID:`, deletedImageIds);
      }

      await conn.commit();
      console.log('✅ 事务提交成功 - 图片关联更新完成');

      return {
        success: true,
        affectedRows: imageIds.length,
        deletedCount: deletedImageIds.length,
        coverSet: !!coverImageId,
      };
    } catch (error) {
      await conn.rollback();
      console.error('❌ 事务回滚 - 更新图片关联失败:', error);
      throw error;
    } finally {
      conn.release();
    }
  };

  /**
   * 根据ID删除图片（包含元数据）
   * @param {Array<number>} imageIds - 图片ID数组
   * @returns {Promise} 删除结果
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   */
  deleteImages = async (imageIds) => {
    if (!imageIds || imageIds.length === 0) return null;
    try {
      // 由于外键级联删除，只需删除 file 表记录，image_meta 会自动删除
      const statement = `DELETE FROM file WHERE ${SqlUtils.queryIn('id', imageIds)} AND file_type = 'image';`;
      const [result] = await connection.execute(statement, imageIds);
      return result;
    } catch (error) {
      console.error('deleteImages error:', error);
      throw error;
    }
  };

  /**
   * 根据ID查询图片文件名（用于删除物理文件）
   * @param {Array<number>} imageIds - 图片ID数组
   * @returns {Promise<Array>} 图片信息数组
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   */
  findImagesByIds = async (imageIds) => {
    if (!imageIds || imageIds.length === 0) return [];
    try {
      const statement = `
        SELECT f.filename
        FROM file f
        WHERE ${SqlUtils.queryIn('f.id', imageIds)} AND f.file_type = 'image';
      `;
      const [result] = await connection.execute(statement, imageIds);
      return result;
    } catch (error) {
      console.error('findImagesByIds error:', error);
      throw error;
    }
  };

  /**
   * 获取文章的所有图片（包含元数据）
   * @param {number} articleId - 文章ID
   * @returns {Promise<Array>} 图片列表
   */
  getArticleImages = async (articleId) => {
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
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.error('getArticleImages error:', error);
      throw error;
    }
  };
}

module.exports = new ImageService();
