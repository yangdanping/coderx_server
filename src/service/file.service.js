const { connection } = require('../app');

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
   */
  findFileById = async (fileIds) => {
    try {
      const statement = `SELECT f.filename, f.file_type FROM file f WHERE f.id IN (${fileIds.join(',')});`;
      const [result] = await connection.execute(statement);
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
   */
  delete = async (fileIds) => {
    try {
      const statement = `DELETE FROM file f WHERE f.id IN (${fileIds.join(',')});`;
      const [result] = await connection.execute(statement);
      return result;
    } catch (error) {
      console.log('delete error:', error);
      throw error;
    }
  };
}

module.exports = new FileService();
