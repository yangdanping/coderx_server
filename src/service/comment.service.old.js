const connection = require('@/app/database');
const { baseURL, redirectURL } = require('@/constants/urls');
class CommentService {
  addComment = async (userId, articleId, content) => {
    try {
      const statement = `INSERT INTO comment (user_id,article_id,content) VALUES (?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  reply = async (userId, articleId, commentId, content) => {
    try {
      const statement = `INSERT INTO comment (user_id,article_id,comment_id,content) VALUES (?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, commentId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  replyToComment = async (userId, articleId, commentId, replyId, content) => {
    try {
      const statement = `INSERT INTO comment (user_id,article_id,comment_id,reply_id,content) VALUES (?,?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, commentId, replyId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  update = async (content, commentId) => {
    try {
      const statement = `UPDATE comment SET content = ? WHERE id = ?;`;
      const [result] = await connection.execute(statement, [content, commentId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  delete = async (commentId) => {
    try {
      const statement = `DELETE FROM comment WHERE id = ?;`;
      const [result] = await connection.execute(statement, [commentId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  /**
   * 重构说明：
   * 1. 修复 LIKE 子句中的 SQL 注入风险。
   * 2. 将 offset 和 limit 参数放到 values 数组中。
   */
  getCommentList = async (offset, limit, articleId, userId) => {
    try {
      const statement = `
      SELECT c.id,
      c.content,c.status,c.comment_id cid,c.reply_id rid, c.create_at createAt,
      JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) author,
      COUNT(cl.user_id) likes,

      JSON_OBJECT('id',a.id,'title',a.title) article,

      (SELECT JSON_ARRAYAGG(CONCAT('${baseURL}/article/images/',file.filename,'?type=small'))
      FROM file WHERE a.id = file.article_id) cover,

      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM comment c
      LEFT JOIN article a ON c.article_id = a.id
      LEFT JOIN user u ON u.id = c.user_id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN comment_like cl ON c.id = cl.comment_id
      WHERE article_id LIKE ? AND u.id LIKE ?
      GROUP BY c.id
      ORDER BY c.create_at DESC
      LIMIT ?,?;
      `;
      const [result] = await connection.execute(statement, [`%${articleId}%`, `%${userId}%`, offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  getCommentById = async (commentId) => {
    try {
      // const statement = `SELECT COUNT(cl.user_id) likes FROM comment c
      // LEFT JOIN comment_like cl ON c.id = cl.comment_id
      // WHERE c.id = ?;`;
      const statement = `SELECT c.id,
      c.content,c.status,c.comment_id cid,c.reply_id rid, c.create_at createAt,
      JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) author,
      COUNT(cl.user_id) likes,

      JSON_OBJECT('id',a.id,'title',a.title) article,

      (SELECT JSON_ARRAYAGG(CONCAT('${baseURL}/article/images/',file.filename,'?type=small'))
      FROM file WHERE a.id = file.article_id) cover,

      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM comment c
      LEFT JOIN article a ON c.article_id = a.id
      LEFT JOIN user u ON u.id = c.user_id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN comment_like cl ON c.id = cl.comment_id
      WHERE c.id = ?
      GROUP BY c.id;`;
      const [result] = await connection.execute(statement, [commentId]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  };
}

module.exports = new CommentService();
