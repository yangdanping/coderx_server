const connection = require('@/app/database');
const {
  buildAcquireArticleLikeNotificationLockParams,
  buildAcquireArticleLikeNotificationLockSql,
  buildCreateArticleLikeNotificationParams,
  buildCreateArticleLikeNotificationSql,
  buildFindLatestArticleLikeNotificationParams,
  buildFindLatestArticleLikeNotificationSql,
  buildGetNotificationByIdParams,
  buildGetNotificationByIdSql,
  buildGetNotificationListParams,
  buildGetNotificationListSql,
  buildGetUnreadCountSql,
  buildMarkAllNotificationsReadSql,
  buildMarkNotificationReadSql,
} = require('./sql/notification.sql');

const ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;

function toTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function isInsideCooldown(latestNotification, nowMs) {
  if (!latestNotification?.createdAt) return false;

  const latestCreatedAtMs = toTimeMs(latestNotification.createdAt);
  if (!Number.isFinite(latestCreatedAtMs)) return false;

  return nowMs - latestCreatedAtMs < ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS;
}

class NotificationService {
  ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS = ARTICLE_LIKE_NOTIFICATION_COOLDOWN_MS;

  createArticleLikeNotification = async ({ recipientId, actorId, articleId }, options = {}) => {
    if (recipientId === actorId) {
      return { created: false, notification: null, reason: 'self' };
    }

    const ownsConnection = !options.conn;
    const conn = options.conn || (await connection.getConnection());

    try {
      if (ownsConnection) {
        await conn.beginTransaction();
      }
      const keyParams = { recipientId, actorId, articleId };

      await conn.execute(
        buildAcquireArticleLikeNotificationLockSql(),
        buildAcquireArticleLikeNotificationLockParams(keyParams),
      );

      const [latestRows] = await conn.execute(
        buildFindLatestArticleLikeNotificationSql(),
        buildFindLatestArticleLikeNotificationParams(keyParams),
      );
      const latestNotification = latestRows[0] || null;
      const nowMs = options.nowMs ?? Date.now();

      if (isInsideCooldown(latestNotification, nowMs)) {
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

      const [insertResult] = await conn.execute(
        buildCreateArticleLikeNotificationSql(),
        buildCreateArticleLikeNotificationParams(keyParams),
      );
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
        notification: notificationRows[0] || null,
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

  getNotificationList = async (recipientId, pagination = {}) => {
    const [rows] = await connection.execute(
      buildGetNotificationListSql(),
      buildGetNotificationListParams(recipientId, pagination),
    );
    return rows;
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
