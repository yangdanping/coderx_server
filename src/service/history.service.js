const connection = require('@/app/database');
const { baseURL, redirectURL } = require('@/constants/urls');
const {
  buildAddHistorySql,
  buildGetUserHistorySql,
  buildUserHistoryExecuteParams,
} = require('./sql/history.sql');

class HistoryService {
  // 添加浏览记录
  addHistory = async (userId, articleId) => {
    try {
      const statement = buildAddHistorySql();
      const [result] = await connection.execute(statement, [userId, articleId]);
      return result;
    } catch (error) {
      console.log('addHistory error:', error);
      throw error;
    }
  };

  // 获取用户浏览历史
  getUserHistory = async (userId, offset, limit) => {
    try {
      const statement = buildGetUserHistorySql(baseURL, redirectURL);
      const params = buildUserHistoryExecuteParams(userId, offset, limit);
      const [result] = await connection.execute(statement, params);
      return result;
    } catch (error) {
      console.log('getUserHistory error:', error);
      throw error;
    }
  };

  // 获取用户浏览历史总数
  getUserHistoryCount = async (userId) => {
    try {
      const statement = `
        SELECT COUNT(*) as total
        FROM article_history ah
        LEFT JOIN article a ON ah.article_id = a.id
        WHERE ah.user_id = ? AND a.id IS NOT NULL;
      `;
      const [result] = await connection.execute(statement, [userId]);
      return result[0].total;
    } catch (error) {
      console.log('getUserHistoryCount error:', error);
      throw error;
    }
  };

  // 删除单个浏览记录
  deleteHistory = async (userId, articleId) => {
    try {
      const statement = `
        DELETE FROM article_history
        WHERE user_id = ? AND article_id = ?;
      `;
      const [result] = await connection.execute(statement, [userId, articleId]);
      return result;
    } catch (error) {
      console.log('deleteHistory error:', error);
      throw error;
    }
  };

  // 清空用户浏览历史
  clearUserHistory = async (userId) => {
    try {
      const statement = `DELETE FROM article_history WHERE user_id = ?;`;
      const [result] = await connection.execute(statement, [userId]);
      return result;
    } catch (error) {
      console.log('clearUserHistory error:', error);
      throw error;
    }
  };

  // 检查是否已浏览过该文章
  hasViewed = async (userId, articleId) => {
    try {
      const statement = `
        SELECT id FROM article_history
        WHERE user_id = ? AND article_id = ?;
      `;
      const [result] = await connection.execute(statement, [userId, articleId]);
      return result.length > 0;
    } catch (error) {
      console.log('hasViewed error:', error);
      throw error;
    }
  };
}

module.exports = new HistoryService();
