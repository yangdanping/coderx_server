const connection = require('@/app/database');
const { baseURL } = require('@/constants/urls');
const Utils = require('@/utils');
const { hydrateAvatarUrls } = require('@/utils/publicAssetUrls');
const {
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
} = require('./sql/notification.sql');

const ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
const COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
const FOLLOW_NOTIFICATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const COMMENT_EXCERPT_LIMIT = 60;

function toTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function isInsideCooldown(latestNotification, nowMs, cooldownMs) {
  if (!latestNotification?.createdAt) return false;

  const latestCreatedAtMs = toTimeMs(latestNotification.createdAt);
  if (!Number.isFinite(latestCreatedAtMs)) return false;

  return nowMs - latestCreatedAtMs < cooldownMs;
}

function isSameUser(left, right) {
  return String(left) === String(right);
}

function truncateText(value, limit) {
  const chars = Array.from(value || '');
  return chars.length > limit ? chars.slice(0, limit).join('') : chars.join('');
}

class NotificationService {
  ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS = ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS;
  COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS = COMMENT_LIKE_NOTIFICATION_COOLDOWN_MS;
  FOLLOW_NOTIFICATION_COOLDOWN_MS = FOLLOW_NOTIFICATION_COOLDOWN_MS;

  createNotification = async (payload, options = {}) => {
    const ownsConnection = !options.conn;
    const conn = options.conn || (await connection.getConnection());

    try {
      if (ownsConnection) {
        await conn.beginTransaction();
      }

      const [insertResult] = await conn.execute(buildCreateNotificationSql(), buildCreateNotificationParams(payload));
      const notificationId = insertResult.insertId;
      const [notificationRows] = await conn.execute(
        buildGetNotificationByIdSql(),
        buildGetNotificationByIdParams(notificationId),
      );

      if (ownsConnection) {
        await conn.commit();
      }

      return {
        created: true,
        notification: notificationRows[0] ? hydrateAvatarUrls(notificationRows[0], baseURL) : null,
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

  createNotificationWithCooldown = async ({ payload, lockKey, cooldownMs }, options = {}) => {
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
      const latestNotification = latestRows[0] || null;
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

  createArticleLikeNotification = async ({ recipientId, actorId, articleId }, options = {}) => {
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
    { recipientId, actorId, articleId, commentId, parentCommentId, content },
    options = {},
  ) => {
    if (isSameUser(recipientId, actorId)) {
      return { created: false, notification: null, reason: 'self' };
    }

    const commentExcerpt = truncateText(Utils.removeHTMLTag(content), COMMENT_EXCERPT_LIMIT);
    const metadata = { commentExcerpt };
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

  createFollowNotification = async ({ recipientId, actorId }, options = {}) => {
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

  createArticleCommentNotification = async ({ recipientId, actorId, articleId, commentId, content }, options = {}) => {
    if (isSameUser(recipientId, actorId)) {
      return { created: false, notification: null, reason: 'self' };
    }

    const commentExcerpt = truncateText(Utils.removeHTMLTag(content), COMMENT_EXCERPT_LIMIT);

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

  createCommentReplyNotification = async ({ recipientId, actorId, articleId, commentId, replyId, content, recipientRole }, options = {}) => {
    if (isSameUser(recipientId, actorId)) {
      return { created: false, notification: null, reason: 'self' };
    }

    const commentExcerpt = truncateText(Utils.removeHTMLTag(content), COMMENT_EXCERPT_LIMIT);
    const metadata = { commentExcerpt };
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

  getNotificationList = async (recipientId, pagination = {}) => {
    const [rows] = await connection.execute(
      buildGetNotificationListSql(),
      buildGetNotificationListParams(recipientId, pagination),
    );
    return hydrateAvatarUrls(rows, baseURL);
  };

  getUnreadCount = async (recipientId) => {
    const [rows] = await connection.execute(buildGetUnreadCountSql(), [recipientId]);
    return Number(rows[0]?.count ?? 0);
  };

  markAsRead = async (notificationId, recipientId) => {
    const [result] = await connection.execute(buildMarkNotificationReadSql(), [notificationId, recipientId]);
    return result;
  };

  markAllAsRead = async (recipientId) => {
    const [result] = await connection.execute(buildMarkAllNotificationsReadSql(), [recipientId]);
    return result;
  };
}

module.exports = new NotificationService();
