const { connection } = require('../app');
const { baseURL, redirectURL } = require('../constants/urls');
class CommentService {
  async addComment(userId, articleId, content) {
    try {
      const statement = `INSERT INTO comment (user_id,article_id,content) VALUES (?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async reply(userId, articleId, commentId, content) {
    try {
      const statement = `INSERT INTO comment (user_id,article_id,comment_id,content) VALUES (?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, commentId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async replyToComment(userId, articleId, commentId, replyId, content) {
    try {
      const statement = `INSERT INTO comment (user_id,article_id,comment_id,reply_id,content) VALUES (?,?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, commentId, replyId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async update(content, commentId) {
    try {
      const statement = `UPDATE comment SET content = ? WHERE id = ?;`;
      const [result] = await connection.execute(statement, [content, commentId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async delete(commentId) {
    try {
      const statement = `DELETE FROM comment WHERE id = ?;`;
      const [result] = await connection.execute(statement, [commentId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getCommentList(offset, limit, articleId, userId) {
    console.log('getCommentList getCommentList', offset, limit, articleId, userId);
    try {
      // 注意!获取了comment_id才能知道你当前这个评论是否是回复了别人的评论,知道这个东西前端在那边展示的时候就知道这条评论展示在什么位置了
      // const statement = `SELECT * FROM comment WHERE article_id = ?;`;
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
      WHERE article_id LIKE '%${articleId}%' AND u.id LIKE '%${userId}%'
      GROUP BY c.id
      ORDER BY c.create_at DESC
      LIMIT ?,?;
      `;
      // const statement = `
      // SELECT c.id, c.content,c.status,c.comment_id cid,c.reply_id rid, c.create_at createAt,
      // JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) user,
      // COUNT(cl.user_id) likes
      // FROM comment c
      // LEFT JOIN user u ON u.id = c.user_id
      // LEFT JOIN profile p ON u.id = p.user_id
      // LEFT JOIN comment_like cl ON c.id = cl.comment_id
      // WHERE article_id = ?
      // GROUP BY c.id
      // ORDER BY c.create_at DESC;`;
      const [result] = await connection.execute(statement, [offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getCommentById(commentId) {
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
  }
}

module.exports = new CommentService();
