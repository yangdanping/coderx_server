import type { DatabaseAdapter, DatabaseTransaction, MutationResult } from '../app/database/database.types.js';
import { removeHTMLTag } from '../utils/text.js';
import { hydrateAvatarUrls } from '../utils/publicAssetUrls.js';
import {
  buildAcquireNotificationLockParams,
  buildAcquireNotificationLockSql,
  buildAcquireArticleLikeNotificationLockParams,
  buildCreateNotificationParams,
  buildCreateNotificationSql,
  buildFindLatestNotificationParams,
  buildFindLatestNotificationSql,
  buildGetNotificationByIdParams,
  buildGetNotificationByIdSql,
  buildGetNotificationListParams,
  buildGetNotificationListSql,
  buildGetUnreadCountSql,
  buildMarkAllNotificationsReadSql,
  buildMarkNotificationReadSql,
  type NotificationMetadata,
} from './sql/notification.sql.js';

const ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
const COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
const FOLLOW_NOTIFICATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const COMMENT_EXCERPT_LIMIT = 60;

type NotificationId = number | string;
type NewNotification = Parameters<typeof buildCreateNotificationParams>[0];
type ArticleLikeNotification = Parameters<typeof buildAcquireArticleLikeNotificationLockParams>[0];
type NotificationPagination = Parameters<typeof buildGetNotificationListParams>[1];

interface NotificationActors {
  recipientId: unknown;
  actorId: unknown;
}

interface CommentNotification extends NotificationActors {
  articleId: unknown;
  commentId: unknown;
  content: unknown;
}

interface LatestNotification {
  id: NotificationId;
  createdAt: Date | string;
  readAt: Date | string | null;
}

interface NotificationRow extends LatestNotification {
  recipientId: NotificationId;
  actorId: NotificationId;
  type: NewNotification['type'];
  targetType: NewNotification['targetType'];
  targetId: NotificationId;
  articleId: NotificationId | null;
  commentId: NotificationId | null;
  metadata: NotificationMetadata;
  lastOccurredAt: Date | string;
  actor: { id: NotificationId | null; name: string | null; avatarUrl: string | null };
  article: { id: NotificationId | null; title: string | null };
  comment: { id: NotificationId | null; content: string | null };
}

interface NotificationOptions {
  conn?: DatabaseTransaction;
  nowMs?: number;
}

export interface NotificationResult {
  created: boolean;
  notification: NotificationRow | null;
  reason?: 'self' | 'cooldown';
  latestNotification?: LatestNotification;
}

interface NotificationWithCooldown {
  payload: NewNotification;
  lockKey: string;
  cooldownMs: number;
}

function toTimeMs(value: Date | string): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function isInsideCooldown(latestNotification: LatestNotification | null, nowMs: number, cooldownMs: number): boolean {
  if (!latestNotification?.createdAt) return false;

  const latestCreatedAtMs = toTimeMs(latestNotification.createdAt);
  if (!Number.isFinite(latestCreatedAtMs)) return false;

  return nowMs - latestCreatedAtMs < cooldownMs;
}

function isSameUser(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

function truncateText(value: string, limit: number): string {
  const chars = Array.from(value || '');
  return chars.length > limit ? chars.slice(0, limit).join('') : chars.join('');
}

export function createNotificationService(connection: DatabaseAdapter, baseURL: string) {
  return new (class NotificationService {
    ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS = ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS;
    COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS = COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS;
    FOLLOW_NOTIFICATION_COOLDOWN_MS = FOLLOW_NOTIFICATION_COOLDOWN_MS;

    createNotification = async (payload: NewNotification, options: NotificationOptions = {}): Promise<NotificationResult> => {
      const ownsConnection = !options.conn;
      const conn = options.conn || (await connection.getConnection());

      try {
        if (ownsConnection) {
          await conn.beginTransaction();
        }

        const [insertResult] = await conn.execute(buildCreateNotificationSql(), buildCreateNotificationParams(payload));
        const notificationId = (insertResult as Pick<MutationResult, 'insertId'>).insertId;
        const [rows] = await conn.execute(
          buildGetNotificationByIdSql(),
          buildGetNotificationByIdParams(notificationId),
        );

        if (ownsConnection) {
          await conn.commit();
        }

        const notification = (rows as NotificationRow[])[0];
        return {
          created: true,
          notification: notification ? hydrateAvatarUrls(notification, baseURL) : null,
        };
      } catch (error) {
        if (ownsConnection) {
          await conn.rollback();
        }
        throw error;
      } finally {
        if (ownsConnection) {
          conn.release();
        }
      }
    };

    createNotificationWithCooldown = async (
      { payload, lockKey, cooldownMs }: NotificationWithCooldown,
      options: NotificationOptions = {},
    ): Promise<NotificationResult> => {
      if (isSameUser(payload.recipientId, payload.actorId)) {
        return { created: false, notification: null, reason: 'self' };
      }

      const ownsConnection = !options.conn;
      const conn = options.conn || (await connection.getConnection());

      try {
        if (ownsConnection) {
          await conn.beginTransaction();
        }

        await conn.execute(buildAcquireNotificationLockSql(), buildAcquireNotificationLockParams(lockKey));

        const [latestRows] = await conn.execute(
          buildFindLatestNotificationSql(),
          buildFindLatestNotificationParams(payload),
        );
        const latestNotification = (latestRows as LatestNotification[])[0] || null;
        const nowMs = options.nowMs ?? Date.now();

        if (isInsideCooldown(latestNotification, nowMs, cooldownMs)) {
          if (ownsConnection) {
            await conn.commit();
          }
          return {
            created: false,
            notification: null,
            reason: 'cooldown',
            latestNotification,
          };
        }

        const notificationResult = await this.createNotification(payload, { conn });

        if (ownsConnection) {
          await conn.commit();
        }

        return notificationResult;
      } catch (error) {
        if (ownsConnection) {
          await conn.rollback();
        }
        throw error;
      } finally {
        if (ownsConnection) {
          conn.release();
        }
      }
    };

    createArticleLikeNotification = async (
      { recipientId, actorId, articleId }: ArticleLikeNotification,
      options: NotificationOptions = {},
    ): Promise<NotificationResult> => {
      if (isSameUser(recipientId, actorId)) {
        return { created: false, notification: null, reason: 'self' };
      }

      return this.createNotificationWithCooldown(
        {
          payload: {
            recipientId,
            actorId,
            type: 'article_like',
            targetType: 'article',
            targetId: articleId,
            articleId,
          },
          lockKey: buildAcquireArticleLikeNotificationLockParams({ recipientId, actorId, articleId })[0],
          cooldownMs: ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS,
        },
        options,
      );
    };

    createCommentLikeNotification = async (
      { recipientId, actorId, articleId, commentId, parentCommentId, content }: CommentNotification & { parentCommentId?: unknown },
      options: NotificationOptions = {},
    ): Promise<NotificationResult> => {
      if (isSameUser(recipientId, actorId)) {
        return { created: false, notification: null, reason: 'self' };
      }

      const commentExcerpt = truncateText(removeHTMLTag(content), COMMENT_EXCERPT_LIMIT);
      const metadata: NotificationMetadata = { commentExcerpt };
      if (parentCommentId != null) {
        metadata.parentCommentId = parentCommentId;
      }

      return this.createNotificationWithCooldown(
        {
          payload: {
            recipientId,
            actorId,
            type: 'comment_like',
            targetType: 'comment',
            targetId: commentId,
            articleId,
            commentId,
            metadata,
          },
          lockKey: `comment_like:${recipientId}:${actorId}:comment:${commentId}`,
          cooldownMs: COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS,
        },
        options,
      );
    };

    createFollowNotification = async (
      { recipientId, actorId }: NotificationActors,
      options: NotificationOptions = {},
    ): Promise<NotificationResult> => {
      if (isSameUser(recipientId, actorId)) {
        return { created: false, notification: null, reason: 'self' };
      }

      return this.createNotificationWithCooldown(
        {
          payload: {
            recipientId,
            actorId,
            type: 'follow',
            targetType: 'user',
            targetId: recipientId,
            articleId: null,
          },
          lockKey: `follow:${recipientId}:${actorId}:user:${recipientId}`,
          cooldownMs: FOLLOW_NOTIFICATION_COOLDOWN_MS,
        },
        options,
      );
    };

    createArticleCommentNotification = async (
      { recipientId, actorId, articleId, commentId, content }: CommentNotification,
      options: NotificationOptions = {},
    ): Promise<NotificationResult> => {
      if (isSameUser(recipientId, actorId)) {
        return { created: false, notification: null, reason: 'self' };
      }

      const commentExcerpt = truncateText(removeHTMLTag(content), COMMENT_EXCERPT_LIMIT);

      return this.createNotification(
        {
          recipientId,
          actorId,
          type: 'article_comment',
          targetType: 'article',
          targetId: articleId,
          articleId,
          commentId,
          metadata: { commentExcerpt },
        },
        options,
      );
    };

    createCommentReplyNotification = async (
      { recipientId, actorId, articleId, commentId, replyId, content, recipientRole }: CommentNotification & Pick<NotificationMetadata, 'replyId' | 'recipientRole'>,
      options: NotificationOptions = {},
    ): Promise<NotificationResult> => {
      if (isSameUser(recipientId, actorId)) {
        return { created: false, notification: null, reason: 'self' };
      }

      const commentExcerpt = truncateText(removeHTMLTag(content), COMMENT_EXCERPT_LIMIT);
      const metadata: NotificationMetadata = { commentExcerpt };
      if (replyId != null) {
        metadata.replyId = replyId;
      }
      if (recipientRole) {
        metadata.recipientRole = recipientRole;
      }

      return this.createNotification(
        {
          recipientId,
          actorId,
          type: 'comment_reply',
          targetType: 'article',
          targetId: articleId,
          articleId,
          commentId,
          metadata,
        },
        options,
      );
    };

    getNotificationList = async (recipientId: unknown, pagination: NotificationPagination = {}): Promise<NotificationRow[]> => {
      const [rows] = await connection.execute(
        buildGetNotificationListSql(),
        buildGetNotificationListParams(recipientId, pagination),
      );
      return hydrateAvatarUrls(rows as NotificationRow[], baseURL);
    };

    getUnreadCount = async (recipientId: unknown): Promise<number> => {
      const [rows] = await connection.execute(buildGetUnreadCountSql(), [recipientId]);
      return Number((rows as { count: number | string }[])[0]?.count ?? 0);
    };

    markAsRead = async (notificationId: string, recipientId: unknown): Promise<MutationResult> => {
      const [result] = await connection.execute(buildMarkNotificationReadSql(), [notificationId, recipientId]);
      return result as MutationResult;
    };

    markAllAsRead = async (recipientId: unknown): Promise<MutationResult> => {
      const [result] = await connection.execute(buildMarkAllNotificationsReadSql(), [recipientId]);
      return result as MutationResult;
    };
  })();
}
