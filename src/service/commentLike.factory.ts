import type { DatabaseAdapter, MutationResult } from '../app/database/database.types.js';
import BusinessError from '../errors/BusinessError.js';
import type { createNotificationService, NotificationResult } from './notification.factory.js';

interface CommentLikeDependencies {
  connection: Pick<DatabaseAdapter, 'getConnection'>;
  notificationService: Pick<ReturnType<typeof createNotificationService>, 'createCommentLikeNotification'>;
  publishNotificationCreated: (notification: unknown) => Promise<unknown>;
}

interface CommentNotificationContext {
  authorId: number | string;
  articleId: number | string;
  parentCommentId: number | string | null;
  content: string;
}

interface CommentLikeResult {
  isLiked: boolean;
  action: 'liked' | 'unliked';
  notificationCreated: boolean;
  notification: NotificationResult['notification'];
}

function buildGetCommentNotificationContextSql() {
  return `
    SELECT
      user_id AS "authorId",
      article_id AS "articleId",
      comment_id AS "parentCommentId",
      content
    FROM comment
    WHERE id = ?
    LIMIT 1;
  `;
}

function isSameUser(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

export function createCommentLikeService({ connection, notificationService, publishNotificationCreated }: CommentLikeDependencies) {
  return new (class CommentLikeService {
    toggleCommentLike = async (commentId: string, userId: unknown): Promise<CommentLikeResult> => {
      const conn = await connection.getConnection();
      let notificationResult: NotificationResult = { created: false, notification: null };

      try {
        await conn.beginTransaction();

        const [deleteResult] = await conn.execute(
          'DELETE FROM comment_like WHERE comment_id = ? AND user_id = ?;',
          [commentId, userId],
        );

        if ((deleteResult as Pick<MutationResult, 'affectedRows'>).affectedRows > 0) {
          await conn.commit();
          return { isLiked: false, action: 'unliked', notificationCreated: false, notification: null };
        }

        const [commentRows] = await conn.execute(buildGetCommentNotificationContextSql(), [commentId]);
        const comment = (commentRows as CommentNotificationContext[])[0];
        if (!comment) {
          throw new BusinessError('评论不存在', 404);
        }

        await conn.execute('INSERT INTO comment_like (comment_id, user_id) VALUES (?, ?);', [commentId, userId]);

        if (!isSameUser(comment.authorId, userId)) {
          notificationResult = await notificationService.createCommentLikeNotification(
            {
              recipientId: comment.authorId,
              actorId: userId,
              articleId: comment.articleId,
              commentId,
              parentCommentId: comment.parentCommentId,
              content: comment.content,
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
          console.warn('⚠️ 评论点赞通知实时推送失败，将由 REST 同步兜底:', error instanceof Error ? error.message : String(error));
        }
      }

      return {
        isLiked: true,
        action: 'liked',
        notificationCreated: notificationResult.created,
        notification: notificationResult.notification,
      };
    };
  })();
}
