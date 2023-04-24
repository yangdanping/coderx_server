const { connection } = require('../app');

class AuthService {
  /* 根据表名/内容id/用户id从数据库中查询该用户是否具备更新/删除<某表>的权限
  id和user_id是固定的,这里只需改表名 */
  async checkPermission(tableName, dataId, userId) {
    try {
      const statement = `SELECT * FROM ${tableName} WHERE id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return result[0] ? true : false; //由于查询语句,查出来是个数组,若数组有数据则表示有权限
    } catch (error) {
      console.log(error);
    }
  }

  async checkStatus(userId) {
    try {
      const statement = `SELECT status FROM user WHERE id = ?;`;
      const [result] = await connection.execute(statement, [userId]);
      const { status } = result[0];
      return status;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new AuthService();
