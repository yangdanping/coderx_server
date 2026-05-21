function buildNotificationSelectFields() {
  return `
      n.id,
      n.recipient_id AS "recipientId",
      n.actor_id AS "actorId",
      n.type,
      n.target_type AS "targetType",
      n.target_id AS "targetId",
      n.article_id AS "articleId",
      n.comment_id AS "commentId",
      n.metadata,
      n.read_at AS "readAt",
      n.created_at AS "createdAt",
      n.last_occurred_at AS "lastOccurredAt",
      jsonb_build_object(
        'id', actor.id,
        'name', actor.name,
        'avatarUrl', actor_profile.avatar_url
      ) AS "actor",
      jsonb_build_object(
        'id', a.id,
        'title', a.title
      ) AS "article",
      jsonb_build_object(
        'id', c.id,
        'content', c.content
      ) AS "comment"
  `;
}

function buildNotificationDisplayJoins() {
  return `
    LEFT JOIN "user" actor ON actor.id = n.actor_id
    LEFT JOIN profile actor_profile ON actor_profile.user_id = actor.id
    LEFT JOIN article a ON a.id = n.article_id
    LEFT JOIN comment c ON c.id = n.comment_id
  `;
}

function buildCreateNotificationSql() {
  return `
    INSERT INTO notifications (
      recipient_id,
      actor_id,
      type,
      target_type,
      target_id,
      article_id,
      comment_id,
      metadata,
      created_at,
      last_occurred_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, clock_timestamp(), clock_timestamp())
    RETURNING
      id,
      recipient_id AS "recipientId",
      actor_id AS "actorId",
      type,
      target_type AS "targetType",
      target_id AS "targetId",
      article_id AS "articleId",
      comment_id AS "commentId",
      metadata,
      read_at AS "readAt",
      created_at AS "createdAt",
      last_occurred_at AS "lastOccurredAt";
  `;
}

function buildCreateNotificationParams({
  recipientId,
  actorId,
  type,
  targetType,
  targetId,
  articleId,
  commentId = null,
  metadata = {},
}) {
  return [recipientId, actorId, type, targetType, targetId, articleId, commentId, JSON.stringify(metadata)];
}

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

function buildAcquireNotificationLockSql() {
  return 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));';
}

function buildAcquireNotificationLockParams(lockKey) {
  return [lockKey];
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

function buildFindLatestNotificationSql() {
  return `
    SELECT
      id,
      created_at AS "createdAt",
      read_at AS "readAt"
    FROM notifications
    WHERE recipient_id = ?
      AND actor_id = ?
      AND type = ?
      AND target_type = ?
      AND target_id = ?
    ORDER BY created_at DESC
    LIMIT 1;
  `;
}

function buildFindLatestNotificationParams({ recipientId, actorId, type, targetType, targetId }) {
  return [recipientId, actorId, type, targetType, targetId];
}

function buildGetNotificationByIdSql() {
  return `
    SELECT
      ${buildNotificationSelectFields()}
    FROM notifications n
    ${buildNotificationDisplayJoins()}
    WHERE n.id = ?
    LIMIT 1;
  `;
}

function buildGetNotificationByIdParams(notificationId) {
  return [notificationId];
}

function buildGetNotificationListSql() {
  return `
    SELECT
      ${buildNotificationSelectFields()}
    FROM notifications n
    ${buildNotificationDisplayJoins()}
    WHERE n.recipient_id = ?
    ORDER BY n.created_at DESC
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
  buildAcquireNotificationLockParams,
  buildAcquireNotificationLockSql,
  buildAcquireArticleLikeNotificationLockParams,
  buildAcquireArticleLikeNotificationLockSql,
  buildCreateArticleLikeNotificationParams,
  buildCreateArticleLikeNotificationSql,
  buildCreateNotificationParams,
  buildCreateNotificationSql,
  buildFindLatestArticleLikeNotificationParams,
  buildFindLatestArticleLikeNotificationSql,
  buildFindLatestNotificationParams,
  buildFindLatestNotificationSql,
  buildGetNotificationByIdParams,
  buildGetNotificationByIdSql,
  buildGetNotificationListParams,
  buildGetNotificationListSql,
  buildGetUnreadCountSql,
  buildMarkAllNotificationsReadSql,
  buildMarkNotificationReadSql,
};
