const connection = require('@/app/database');
const BusinessError = require('@/errors/BusinessError');
const notificationService = require('@/service/notification.service');
const { publishNotificationCreated } = require('@/socket/notification/notificationEventBus');

function buildGetArticleAuthorSql() {
  return 'SELECT user_id AS "authorId" FROM article WHERE id = ? LIMIT 1;';
}

class ArticleLikeService {
  toggleArticleLike = async (articleId, userId) => {
    const conn = await connection.getConnection();
    let notificationResult = { created: false, notification: null };

    try {
      await conn.beginTransaction();

      const [deleteResult] = await conn.execute('DELETE FROM article_like WHERE article_id = ? AND user_id = ?;', [
        articleId,
        userId,
      ]);

      if (deleteResult.affectedRows > 0) {
        await conn.commit();
        return { isLiked: false, action: 'unliked', notificationCreated: false, notification: null };
      }

      const [articleRows] = await conn.execute(buildGetArticleAuthorSql(), [articleId]);
      const article = articleRows[0];
      if (!article) {
        throw new BusinessError('文章不存在', 404);
      }

      await conn.execute('INSERT INTO article_like (article_id, user_id) VALUES (?, ?);', [articleId, userId]);

      if (String(article.authorId) !== String(userId)) {
        notificationResult = await notificationService.createArticleLikeNotification(
          {
            recipientId: article.authorId,
            actorId: userId,
            articleId,
          },
          { conn },
        );
      }

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    if (notificationResult.created && notificationResult.notification) {
      try {
        await publishNotificationCreated(notificationResult.notification);
      } catch (error) {
        console.warn('⚠️ 文章点赞通知实时推送失败，将由 REST 同步兜底:', error.message);
      }
    }

    return {
      isLiked: true,
      action: 'liked',
      notificationCreated: notificationResult.created,
      notification: notificationResult.notification,
    };
  };
}

module.exports = new ArticleLikeService();
