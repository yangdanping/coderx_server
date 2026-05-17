function buildCreateArticleLikeNotificationSql() {
  return `
    INSERT INTO notifications (
      recipient_id,
      actor_id,
      type,
      target_type,
      target_id,
      article_id,
      created_at,
      last_occurred_at
    )
    VALUES (?, ?, 'article_like', 'article', ?, ?, clock_timestamp(), clock_timestamp())
    RETURNING
      id,
      recipient_id AS "recipientId",
      actor_id AS "actorId",
      type,
      target_type AS "targetType",
      target_id AS "targetId",
      article_id AS "articleId",
      read_at AS "readAt",
      created_at AS "createdAt",
      last_occurred_at AS "lastOccurredAt";
  `;
}

function buildCreateArticleLikeNotificationParams({ recipientId, actorId, articleId }) {
  return [recipientId, actorId, articleId, articleId];
}

function buildAcquireArticleLikeNotificationLockSql() {
  return 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));';
}

function buildAcquireArticleLikeNotificationLockParams({ recipientId, actorId, articleId }) {
  return [`article_like:${recipientId}:${actorId}:article:${articleId}`];
}

function buildFindLatestArticleLikeNotificationSql() {
  return `
    SELECT
      id,
      created_at AS "createdAt",
      read_at AS "readAt"
    FROM notifications
    WHERE recipient_id = ?
      AND actor_id = ?
      AND type = 'article_like'
      AND target_type = 'article'
      AND target_id = ?
    ORDER BY created_at DESC
    LIMIT 1;
  `;
}

function buildFindLatestArticleLikeNotificationParams({ recipientId, actorId, articleId }) {
  return [recipientId, actorId, articleId];
}

function buildGetNotificationByIdSql() {
  return `
    SELECT
      id,
      recipient_id AS "recipientId",
      actor_id AS "actorId",
      type,
      target_type AS "targetType",
      target_id AS "targetId",
      article_id AS "articleId",
      read_at AS "readAt",
      created_at AS "createdAt",
      last_occurred_at AS "lastOccurredAt"
    FROM notifications
    WHERE id = ?
    LIMIT 1;
  `;
}

function buildGetNotificationByIdParams(notificationId) {
  return [notificationId];
}

function buildGetNotificationListSql() {
  return `
    SELECT
      id,
      recipient_id AS "recipientId",
      actor_id AS "actorId",
      type,
      target_type AS "targetType",
      target_id AS "targetId",
      article_id AS "articleId",
      read_at AS "readAt",
      created_at AS "createdAt",
      last_occurred_at AS "lastOccurredAt"
    FROM notifications
    WHERE recipient_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?;
  `;
}

function buildGetNotificationListParams(recipientId, { offset = 0, limit = 20 } = {}) {
  return [recipientId, limit, offset];
}

function buildGetUnreadCountSql() {
  return `
    SELECT COUNT(*)::bigint AS count
    FROM notifications
    WHERE recipient_id = ? AND read_at IS NULL;
  `;
}

function buildMarkNotificationReadSql() {
  return `
    UPDATE notifications
    SET read_at = COALESCE(read_at, now())
    WHERE id = ? AND recipient_id = ?;
  `;
}

function buildMarkAllNotificationsReadSql() {
  return `
    UPDATE notifications
    SET read_at = COALESCE(read_at, now())
    WHERE recipient_id = ? AND read_at IS NULL;
  `;
}

module.exports = {
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
};
