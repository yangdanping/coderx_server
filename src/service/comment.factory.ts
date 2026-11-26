import type { DatabaseAdapter, DatabaseTransaction, MutationResult, QueryExecutor } from '../app/database/database.types.js';
import SqlUtils from '../utils/SqlUtils.js';
import { hydrateAvatarUrls } from '../utils/publicAssetUrls.js';
import type { createNotificationService, NotificationResult } from './notification.factory.js';
import {
  buildAddCommentSql,
  buildAddReplySql,
  buildGetCommentAuthorSql,
  buildGetCommentListSql,
  buildGetCommentByIdSql,
  buildGetRepliesSql,
  buildGetReplyPreviewSql,
  buildGetUserCommentListSql,
  buildGetUserCommentCountSql,
  buildUserCommentListExecuteParams,
} from './sql/comment.sql.js';

type CommentId = number | string;
type CommentSort = 'latest' | 'oldest' | 'hot';
type RecipientRole = 'comment_author' | 'article_author';

interface CommentAuthor {
  id: CommentId | null;
  name: string | null;
  nickname: string | null;
  avatarUrl: string | null;
}

interface CommentRow {
  id: CommentId;
  content: string;
  status: boolean | number | null;
  createAt: Date | string;
  author: CommentAuthor;
  likes: number | string;
}

interface CommentReply extends CommentRow {
  cid: CommentId | null;
  rid: CommentId | null;
  replyTo: { id: CommentId | null; name: string | null; content: string | null } | null;
}

interface CommentDetail extends CommentReply {
  articleId: CommentId;
}

interface CommentListItem extends CommentRow {
  replyCount: number | string;
  replies?: CommentReply[];
}

interface UserComment extends CommentRow {
  updateAt: Date | string;
  articleId: CommentId;
  articleTitle: string | null;
  article: { id: CommentId | null; title: string | null };
  articleUrl?: string;
}

interface CommentPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface UserCommentPage {
  items: UserComment[];
  total: number;
  hasMore: boolean;
  pageNum: number;
  pageSize: number;
}

interface CommentDependencies {
  connection: QueryExecutor & Partial<Pick<DatabaseAdapter, 'getConnection'>>;
  baseURL: string;
  notificationService: Pick<ReturnType<typeof createNotificationService>, 'createArticleCommentNotification' | 'createCommentReplyNotification'>;
  publishNotificationCreated: (notification: unknown) => Promise<unknown>;
}

function buildGetArticleAuthorSql() {
  return 'SELECT user_id AS "authorId" FROM article WHERE id = ? LIMIT 1;';
}

function isSameUser(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

function readCommentCursor(cursor: unknown): string | null {
  if (!cursor) return null;
  if (typeof cursor !== 'string') throw new TypeError('cursor.split is not a function');
  return cursor;
}

export function createCommentService({ connection, baseURL, notificationService, publishNotificationCreated }: CommentDependencies) {
  return new (class CommentService {
    /** 获取一级评论列表（分页）。 */
    getCommentList = async (
      articleId: unknown, cursor: unknown, limit: number, sort: CommentSort = 'latest', replyPreviewLimit = 2,
    ): Promise<CommentPage<CommentListItem>> => {
      try {
        const normalizedLimit = Number(limit) || 5;
        const limitForHasMore = String(normalizedLimit + 1);
        let rows: unknown;
        const pageCursor = readCommentCursor(cursor);

        if (sort === 'hot') {
          const queryParams = [articleId];
          const { condition: cursorCondition, params: cursorParams } = SqlUtils.buildHotCursorCondition(pageCursor);
          queryParams.push(...cursorParams, limitForHasMore);

          const statement = buildGetCommentListSql({
            sort: 'hot',
            cursorCondition,
          });
          [rows] = await connection.execute(statement, queryParams);
        } else {
          const isOldest = sort === 'oldest';
          const direction = isOldest ? 'ASC' : 'DESC';
          const queryParams = [articleId];
          const { condition: cursorCondition, params: cursorParams } = SqlUtils.buildTimeCursorCondition(pageCursor, direction);
          queryParams.push(...cursorParams, limitForHasMore);

          const statement = buildGetCommentListSql({
            sort,
            cursorCondition,
            direction,
          });
          [rows] = await connection.execute(statement, queryParams);
        }

        // 判断是否有更多
        const comments = rows as CommentListItem[];
        const hasMore = comments.length > normalizedLimit;
        const items = hasMore ? comments.slice(0, normalizedLimit) : comments;

        // 处理每条评论的内容和状态
        items.forEach((comment) => {
          if (comment.status) {
            comment.content = '评论已被封禁';
          }
        });

        // 为每条一级评论获取前 N 条回复预览
        for (const comment of items) {
          comment.replies = await this.getReplyPreview(comment.id, String(replyPreviewLimit));
        }

        // 计算下一页游标
        let nextCursor: string | null = null;
        if (hasMore && items.length > 0) {
          nextCursor = sort === 'hot' ? SqlUtils.buildHotNextCursor(items[items.length - 1]) : SqlUtils.buildNextCursor(items[items.length - 1]);
        }

        const page = { items, nextCursor, hasMore };
        hydrateAvatarUrls(page, baseURL);
        return page;
      } catch (error) {
        console.error('getCommentList error:', error);
        throw error;
      }
    };

    /** 获取用户的评论列表（标准分页）。 */
    getUserCommentList = async (userId: unknown, offset: string, limit: string): Promise<UserCommentPage> => {
      try {
        const normalizedOffset = Math.max(0, Number(offset) || 0);
        const normalizedLimit = Math.max(1, Number(limit) || 10);
        const statement = buildGetUserCommentListSql();
        const executeParams = buildUserCommentListExecuteParams(
          userId,
          String(normalizedOffset),
          String(normalizedLimit + 1),
        );
        const [rows] = await connection.execute(statement, executeParams);
        const [countRows] = await connection.execute(buildGetUserCommentCountSql(), [userId]);
        const [countResult] = countRows as { total: number | string }[];
        const comments = rows as UserComment[];
        const hasMore = comments.length > normalizedLimit;
        const pageItems = hasMore ? comments.slice(0, normalizedLimit) : comments;

        // 处理数据格式
        const items = pageItems.map((item) => {
          // 组装 articleUrl (假设路由结构)
          item.articleUrl = `/article/${item.articleId}`;

          if (item.status) {
            item.content = '评论已被封禁';
          }
          return item;
        });

        const page = {
          items,
          total: Number(countResult?.total) || 0,
          hasMore,
          pageNum: Math.floor(normalizedOffset / normalizedLimit) + 1,
          pageSize: normalizedLimit,
        };
        hydrateAvatarUrls(page, baseURL);
        return page;
      } catch (error) {
        console.error('getUserCommentList error:', error);
        throw error;
      }
    };

    getReplyPreview = async (commentId: unknown, limit: string): Promise<CommentReply[]> => {
      try {
        const statement = buildGetReplyPreviewSql();

        const [rows] = await connection.execute(statement, [commentId, limit]);
        const replies = rows as CommentReply[];

        replies.forEach((reply) => {
          if (reply.status) {
            reply.content = '评论已被封禁';
          }
        });

        hydrateAvatarUrls(replies, baseURL);
        return replies;
      } catch (error) {
        console.error('getReplyPreview error:', error);
        // A failed preview leaves the surrounding comment page readable.
        return [];
      }
    };

    getReplies = async (commentId: string, cursor: unknown, limit: number): Promise<CommentPage<CommentReply> & { replyCount: number | string }> => {
      try {
        const normalizedLimit = Number(limit) || 10;
        const queryParams: unknown[] = [commentId];
        const { condition: cursorCondition, params: cursorParams } = SqlUtils.buildCursorCondition(readCommentCursor(cursor), 'ASC');
        queryParams.push(...cursorParams);

        const limitForHasMore = String(normalizedLimit + 1);
        queryParams.push(limitForHasMore);

        const statement = buildGetRepliesSql({
          cursorCondition,
        });

        const [rows] = await connection.execute(statement, queryParams);
        const replies = rows as CommentReply[];

        const hasMore = replies.length > normalizedLimit;
        const items = hasMore ? replies.slice(0, normalizedLimit) : replies;

        items.forEach((reply) => {
          if (reply.status) {
            reply.content = '评论已被封禁';
          }
        });

        // 获取该评论下的总回复数
        const [countRows] = await connection.execute('SELECT COUNT(*) AS "replyCount" FROM comment WHERE comment_id = ?', [commentId]);
        const [{ replyCount }] = countRows as { replyCount: number | string }[];

        let nextCursor: string | null = null;
        if (hasMore && items.length > 0) {
          nextCursor = SqlUtils.buildNextCursor(items[items.length - 1]);
        }

        const page = { items, nextCursor, hasMore, replyCount };
        hydrateAvatarUrls(page, baseURL);
        return page;
      } catch (error) {
        console.error('getReplies error:', error);
        throw error;
      }
    };

    /** 获取文章的评论总数（包括所有层级）。 */
    getTotalCount = async (articleId: unknown): Promise<number | string> => {
      try {
        const statement = `SELECT COUNT(*) AS "totalCount" FROM comment WHERE article_id = ?`;
        const [rows] = await connection.execute(statement, [articleId]);
        const [result] = rows as { totalCount: number | string }[];
        return result.totalCount;
      } catch (error) {
        console.error('getTotalCount error:', error);
        // The public count and post-write readback both report zero on lookup failure.
        return 0;
      }
    };

    /** 新增一级评论。 */
    addComment = async (userId: unknown, articleId: unknown, content: unknown): Promise<CommentDetail | null> => {
      const statement = buildAddCommentSql();
      if (typeof connection.getConnection !== 'function') {
        try {
          const [result] = await connection.execute(statement, [userId, articleId, content]);
          const { insertId } = result as Pick<MutationResult, 'insertId'>;

          if (insertId) {
            return await this.getCommentById(insertId);
          }
          return null;
        } catch (error) {
          console.error('addComment error:', error);
          throw error;
        }
      }

      const conn = await connection.getConnection();
      let comment: CommentDetail | null = null;
      let notificationResult: NotificationResult = { created: false, notification: null };

      try {
        await conn.beginTransaction();

        const [result] = await conn.execute(statement, [userId, articleId, content]);
        const { insertId: commentId } = result as Pick<MutationResult, 'insertId'>;

        if (commentId) {
          const [articleRows] = await conn.execute(buildGetArticleAuthorSql(), [articleId]);
          const article = (articleRows as { authorId: CommentId }[])[0];

          if (article && !isSameUser(article.authorId, userId)) {
            notificationResult = await notificationService.createArticleCommentNotification(
              {
                recipientId: article.authorId,
                actorId: userId,
                articleId,
                commentId,
                content,
              },
              { conn },
            );
          }

          comment = await this.getCommentById(commentId, conn);
        }

        await conn.commit();
      } catch (error) {
        await conn.rollback();
        console.error('addComment error:', error);
        throw error;
      } finally {
        conn.release();
      }

      if (notificationResult.created && notificationResult.notification) {
        try {
          await publishNotificationCreated(notificationResult.notification);
        } catch (error) {
          console.warn('⚠️ 文章评论通知实时推送失败，将由 REST 同步兜底:', error instanceof Error ? error.message : String(error));
        }
      }

      return comment;
    };

    /** 回复一级评论或其回复。 */
    addReply = async (userId: unknown, articleId: unknown, commentId: string, replyId: unknown, content: unknown): Promise<CommentDetail | null> => {
      const statement = buildAddReplySql(!!replyId);
      const queryParams = replyId
        ? [userId, articleId, commentId, replyId, content]
        : [userId, articleId, commentId, content];
      if (typeof connection.getConnection !== 'function') {
        try {
          const [result] = await connection.execute(statement, queryParams);
          const { insertId } = result as Pick<MutationResult, 'insertId'>;

          if (insertId) {
            return await this.getCommentById(insertId);
          }
          return null;
        } catch (error) {
          console.error('addReply error:', error);
          throw error;
        }
      }

      const conn = await connection.getConnection();
      let comment: CommentDetail | null = null;
      const notificationResults: NotificationResult[] = [];

      try {
        await conn.beginTransaction();

        const [result] = await conn.execute(statement, queryParams);
        const { insertId: replyCommentId } = result as Pick<MutationResult, 'insertId'>;

        if (replyCommentId) {
          const repliedCommentId = replyId || commentId;
          const [repliedRows] = await conn.execute(buildGetCommentAuthorSql(), [repliedCommentId]);
          const repliedComment = (repliedRows as { authorId: CommentId }[])[0];
          const [articleRows] = await conn.execute(buildGetArticleAuthorSql(), [articleId]);
          const article = (articleRows as { authorId: CommentId }[])[0];
          const recipientCandidates: { recipientId: CommentId; recipientRole: RecipientRole }[] = [];
          const seenRecipientIds = new Set<string>();

          const addRecipientCandidate = (recipientId: CommentId | undefined, recipientRole: RecipientRole) => {
            if (recipientId == null || isSameUser(recipientId, userId)) return;
            const key = String(recipientId);
            if (seenRecipientIds.has(key)) return;
            seenRecipientIds.add(key);
            recipientCandidates.push({ recipientId, recipientRole });
          };

          addRecipientCandidate(repliedComment?.authorId, 'comment_author');
          addRecipientCandidate(article?.authorId, 'article_author');

          for (const recipient of recipientCandidates) {
            const notificationResult = await notificationService.createCommentReplyNotification(
              {
                recipientId: recipient.recipientId,
                actorId: userId,
                articleId,
                commentId,
                replyId: replyCommentId,
                content,
                recipientRole: recipient.recipientRole,
              },
              { conn },
            );

            notificationResults.push(notificationResult);
          }

          comment = await this.getCommentById(replyCommentId, conn);
        }

        await conn.commit();
      } catch (error) {
        await conn.rollback();
        console.error('addReply error:', error);
        throw error;
      } finally {
        conn.release();
      }

      for (const notificationResult of notificationResults) {
        if (notificationResult.created && notificationResult.notification) {
          try {
            await publishNotificationCreated(notificationResult.notification);
          } catch (error) {
            console.warn('⚠️ 评论回复通知实时推送失败，将由 REST 同步兜底:', error instanceof Error ? error.message : String(error));
          }
        }
      }

      return comment;
    };

    /** 获取单条评论详情。 */
    getCommentById = async (commentId: unknown, conn: DatabaseTransaction | null = null): Promise<CommentDetail | null> => {
      try {
        const statement = buildGetCommentByIdSql();
        const execute = conn ? conn.execute.bind(conn) : connection.execute.bind(connection);

        const [rows] = await execute(statement, [commentId]);
        const [comment] = rows as CommentDetail[];

        if (comment && comment.status) {
          comment.content = '评论已被封禁';
        }

        if (!comment) return null;
        hydrateAvatarUrls(comment, baseURL);
        return comment;
      } catch (error) {
        // The write owns this transaction and must roll it back before publishing.
        if (conn) throw error;
        console.error('getCommentById error:', error);
        // Public reads treat an unavailable row as missing.
        return null;
      }
    };

    /** 更新评论内容。 */
    updateComment = async (commentId: string, content: unknown): Promise<CommentDetail | null> => {
      try {
        const statement = `UPDATE comment SET content = ? WHERE id = ?`;
        const [result] = await connection.execute(statement, [content, commentId]);

        if ((result as Pick<MutationResult, 'affectedRows'>).affectedRows > 0) {
          return await this.getCommentById(commentId);
        }
        return null;
      } catch (error) {
        console.error('updateComment error:', error);
        throw error;
      }
    };

    /** 删除评论及其回复。 */
    deleteComment = async (commentId: string): Promise<CommentDetail | null> => {
      try {
        // 先获取评论信息（用于返回）
        const comment = await this.getCommentById(commentId);

        // 删除该评论下的所有回复
        await connection.execute('DELETE FROM comment WHERE comment_id = ?', [commentId]);
        // 删除该评论下回复的回复（如果有 reply_id 指向被删除的回复）
        await connection.execute('DELETE FROM comment WHERE reply_id = ?', [commentId]);
        // 删除该评论本身
        const [result] = await connection.execute('DELETE FROM comment WHERE id = ?', [commentId]);

        return (result as Pick<MutationResult, 'affectedRows'>).affectedRows > 0 ? comment : null;
      } catch (error) {
        console.error('deleteComment error:', error);
        throw error;
      }
    };
  })();
}
