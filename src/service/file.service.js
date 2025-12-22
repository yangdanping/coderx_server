const { connection } = require('../app');
const Utils = require('../utils');

/**
 * 文件服务层（通用）
 * 保留真正通用的文件操作方法
 * 头像、图片、视频的专用逻辑已拆分到各自的 service
 */
class FileService {
  /**
   * 根据文件名获取文件信息（通用方法）
   * @param {string} filename - 文件名
   * @returns {Promise} 文件信息
   */
  getFileByFilename = async (filename) => {
    try {
      const statement = `SELECT * FROM file WHERE filename LIKE ? LIMIT 1;`;
      const [result] = await connection.execute(statement, [`${filename}%`]);
      return result[0];
    } catch (error) {
      console.log('getFileByFilename error:', error);
      throw error;
    }
  };

  /**
   * 根据ID查询文件（通用方法，用于删除等）
   * @param {Array<number>} fileIds - 文件ID数组
   * @returns {Promise<Array>} 文件列表
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   */
  findFileById = async (fileIds) => {
    if (!fileIds || fileIds.length === 0) return [];
    try {
      const statement = `SELECT f.filename, f.file_type FROM file f WHERE ${Utils.formatInClause('f.id', fileIds, '')};`;
      const [result] = await connection.execute(statement, fileIds);
      return result;
    } catch (error) {
      console.log('findFileById error:', error);
      throw error;
    }
  };

  /**
   * 删除文件（通用方法）
   * @param {Array<number>} fileIds - 文件ID数组
   * @returns {Promise} 删除结果
   *
   * 重构说明：
   * 1. 采用 ? 占位符处理 IN 子句。
   */
  delete = async (fileIds) => {
    if (!fileIds || fileIds.length === 0) return null;
    try {
      const statement = `DELETE FROM file f WHERE ${Utils.formatInClause('f.id', fileIds, '')};`;
      const [result] = await connection.execute(statement, fileIds);
      return result;
    } catch (error) {
      console.log('delete error:', error);
      throw error;
    }
  };
}

module.exports = new FileService();
