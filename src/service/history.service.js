const connection = require('@/app/database');
const { baseURL, redirectURL } = require('@/constants/urls');

class HistoryService {
  // 添加浏览记录
  addHistory = async (userId, articleId) => {
    try {
      const statement = `
        INSERT INTO article_history (user_id, article_id) 
        VALUES (?, ?) 
        ON DUPLICATE KEY UPDATE update_at = CURRENT_TIMESTAMP;
      `;
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
      const statement = `
        SELECT
          ah.id,
          ah.create_at createAt,
          ah.update_at updateAt,
          a.id articleId,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at articleCreateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author,
          (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes,
          (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount,
          (SELECT JSON_ARRAYAGG(CONCAT('${baseURL}/article/images/', f.filename, '?type=small'))
           FROM file f WHERE f.article_id = a.id AND f.filename LIKE '%-cover') cover,
          CONCAT('${redirectURL}/article/', a.id) articleUrl
        FROM article_history ah
        LEFT JOIN article a ON ah.article_id = a.id
        LEFT JOIN user u ON a.user_id = u.id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE ah.user_id = ? AND a.id IS NOT NULL
        ORDER BY ah.update_at DESC
        LIMIT ?, ?;
      `;

      const [result] = await connection.execute(statement, [userId, offset, limit]);
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
