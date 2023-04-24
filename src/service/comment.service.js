const { connection } = require('../app');

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
  async getCommentList(articleId) {
    try {
      // 注意!获取了comment_id才能知道你当前这个评论是否是回复了别人的评论,知道这个东西前端在那边展示的时候就知道这条评论展示在什么位置了
      // const statement = `SELECT * FROM comment WHERE article_id = ?;`;
      const statement = `
      SELECT c.id, c.content,c.status,  c.comment_id commentId, c.create_at createAt,
      JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) user,
      COUNT(cl.user_id) likes,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT(
      'id',r.id,'fatherComment',r.father_comment_id, 'content',r.content,'replyId',r.reply_id,'createAt', r.create_at,
      'likes',(SELECT COUNT(rl.user_id) FROM reply_like rl WHERE rl.reply_id = r.id),
      'user',JSON_OBJECT('id', us.id, 'name', us.name,'avatarUrl',pr.avatar_url)))
      FROM reply r
      LEFT JOIN user us ON us.id = r.user_id
      LEFT JOIN profile pr ON us.id = pr.user_id
      WHERE father_comment_id = c.id
      GROUP BY c.id
      ORDER BY r.create_at DESC) replyInfo
      FROM comment c
      LEFT JOIN user u ON u.id = c.user_id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN comment_like cl ON c.id = cl.comment_id
      WHERE article_id = ?
      GROUP BY c.id
      ORDER BY c.create_at DESC;`;
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new CommentService();
