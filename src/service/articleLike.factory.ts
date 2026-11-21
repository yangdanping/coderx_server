import type { MutationResult } from '../app/database/database.types.js';
import BusinessError from '../errors/BusinessError.js';
import type { ArticleLikeService as ArticleLikeServicePort, ArticleLikeServiceDependencies } from './article/article.types.js';

export function createArticleLikeService({ connection, notificationService, publishNotificationCreated }: ArticleLikeServiceDependencies) {
  function buildGetArticleAuthorSql() {
    return 'SELECT user_id AS "authorId" FROM article WHERE id = ? LIMIT 1;';
  }

  class ArticleLikeService implements ArticleLikeServicePort {
    toggleArticleLike = async (articleId: string, userId: unknown) => {
      const conn = await connection.getConnection();
      let notificationResult: { created: boolean; notification: unknown } = { created: false, notification: null };

      try {
        await conn.beginTransaction();

        const [deleteResult] = await conn.execute('DELETE FROM article_like WHERE article_id = ? AND user_id = ?;', [
          articleId,
          userId,
        ]);

        if ((deleteResult as Pick<MutationResult, 'affectedRows'>).affectedRows > 0) {
          await conn.commit();
          return { isLiked: false, action: 'unliked', notificationCreated: false, notification: null };
        }

        const [articleRows] = await conn.execute(buildGetArticleAuthorSql(), [articleId]);
        const article = (articleRows as { authorId: number | string }[])[0];
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
          const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
          console.warn('⚠️ 文章点赞通知实时推送失败，将由 REST 同步兜底:', message);
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
  return new ArticleLikeService();
}
