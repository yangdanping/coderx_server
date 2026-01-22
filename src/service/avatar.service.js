const connection = require('@/app/database');

/**
 * 头像服务层
 * 处理头像相关的数据库操作
 * 注：通用文件方法在 file.service.js
 */
class AvatarService {
  /**
   * 添加头像
   * @param {number} userId - 用户ID
   * @param {string} filename - 文件名
   * @param {string} mimetype - MIME类型
   * @param {number} size - 文件大小
   * @param {object} conn - 数据库连接（可选，用于事务）
   * @returns {Promise} 插入结果
   */
  addAvatar = async (userId, filename, mimetype, size, conn = null) => {
    try {
      const statement = `INSERT INTO avatar (user_id,filename, mimetype, size) VALUES (?,?,?,?)`;
      const execute = conn ? conn.execute.bind(conn) : connection.execute.bind(connection);
      const [result] = await execute(statement, [userId, filename, mimetype, size]);
      return result;
    } catch (error) {
      console.log('addAvatar error:', error);
      throw error;
    }
  };

  /**
   * 根据用户ID获取头像（获取最后一个）
   * @param {number} userId - 用户ID
   * @returns {Promise} 头像信息
   */
  getAvatarById = async (userId) => {
    try {
      const statement = `SELECT * FROM avatar WHERE user_id = ?;`;
      const [result] = await connection.execute(statement, [userId]);
      return result.pop(); //.pop(),取到的永远是数组中的最后一个,也就是该id用户的上传的最后一个头像
    } catch (error) {
      console.log('getAvatarById error:', error);
      throw error;
    }
  };

  /**
   * 根据用户ID查找头像
   * @param {number} userId - 用户ID
   * @returns {Promise} 头像信息
   */
  findAvatarById = async (userId) => {
    try {
      const statement = `SELECT * FROM avatar ar WHERE ar.user_id = ?;`;
      const [result] = await connection.execute(statement, [userId]);
      return result[0];
    } catch (error) {
      console.log('findAvatarById error:', error);
      throw error;
    }
  };

  /**
   * 删除头像
   * @param {number} avatarId - 头像ID
   * @param {object} conn - 数据库连接（可选，用于事务）
   * @returns {Promise} 删除结果
   */
  deleteAvatar = async (avatarId, conn = null) => {
    try {
      const statement = `DELETE FROM avatar ar WHERE ar.id = ?;`;
      const execute = conn ? conn.execute.bind(conn) : connection.execute.bind(connection);
      const [result] = await execute(statement, [avatarId]);
      return result;
    } catch (error) {
      console.log('deleteAvatar error:', error);
      throw error;
    }
  };
}

module.exports = new AvatarService();
