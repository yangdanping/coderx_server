const { connection } = require('../app');

class ReplyService {
  async addReply(userId, articleId, commentId, content) {
    try {
      const statement = `INSERT INTO reply (user_id,article_id,father_comment_id,content) VALUES (?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, commentId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async replyToReply(userId, articleId, commentId, replyId, content) {
    try {
      const statement = `INSERT INTO reply (user_id,article_id,father_comment_id,reply_id,content) VALUES (?,?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, articleId, commentId, replyId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new ReplyService();
