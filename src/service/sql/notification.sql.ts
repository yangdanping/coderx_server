type NotificationType = 'article_like' | 'article_comment' | 'comment_reply' | 'follow' | 'comment_like';
type NotificationTargetType = 'article' | 'user' | 'comment';

interface NotificationActors {
  recipientId: unknown;
  actorId: unknown;
}

interface ArticleLikeNotification extends NotificationActors {
  articleId: unknown;
}

interface NotificationMatch extends NotificationActors {
  type: NotificationType;
  targetType: NotificationTargetType;
  targetId: unknown;
}

export interface NotificationMetadata {
  commentExcerpt?: string;
  parentCommentId?: unknown;
  replyId?: unknown;
  recipientRole?: 'comment_author' | 'article_author';
}

interface NewNotification extends NotificationMatch {
  articleId: unknown;
  commentId?: unknown;
  metadata?: NotificationMetadata;
}

type NotificationPageValue = string | number;

interface NotificationPagination {
  offset?: NotificationPageValue;
  limit?: NotificationPageValue;
}

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

export function buildCreateNotificationSql() {
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

export function buildCreateNotificationParams({
  recipientId,
  actorId,
  type,
  targetType,
  targetId,
  articleId,
  commentId = null,
  metadata = {},
}: NewNotification) {
  return [recipientId, actorId, type, targetType, targetId, articleId, commentId, JSON.stringify(metadata)];
}

export function buildCreateArticleLikeNotificationSql() {
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

export function buildCreateArticleLikeNotificationParams({ recipientId, actorId, articleId }: ArticleLikeNotification) {
  return [recipientId, actorId, articleId, articleId];
}

export function buildAcquireArticleLikeNotificationLockSql() {
  return 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));';
}

export function buildAcquireNotificationLockSql() {
  return 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0));';
}

export function buildAcquireNotificationLockParams(lockKey: string) {
  return [lockKey];
}

export function buildAcquireArticleLikeNotificationLockParams({ recipientId, actorId, articleId }: ArticleLikeNotification) {
  return [`article_like:${recipientId}:${actorId}:article:${articleId}`];
}

export function buildFindLatestArticleLikeNotificationSql() {
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

export function buildFindLatestArticleLikeNotificationParams({ recipientId, actorId, articleId }: ArticleLikeNotification) {
  return [recipientId, actorId, articleId];
}

export function buildFindLatestNotificationSql() {
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

export function buildFindLatestNotificationParams({ recipientId, actorId, type, targetType, targetId }: NotificationMatch) {
  return [recipientId, actorId, type, targetType, targetId];
}

export function buildGetNotificationByIdSql() {
  return `
    SELECT
      ${buildNotificationSelectFields()}
    FROM notifications n
    ${buildNotificationDisplayJoins()}
    WHERE n.id = ?
    LIMIT 1;
  `;
}

export function buildGetNotificationByIdParams(notificationId: unknown) {
  return [notificationId];
}

export function buildGetNotificationListSql() {
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

export function buildGetNotificationListParams(recipientId: unknown, { offset = 0, limit = 20 }: NotificationPagination = {}) {
  return [recipientId, limit, offset];
}

export function buildGetUnreadCountSql() {
  return `
    SELECT COUNT(*)::bigint AS count
    FROM notifications
    WHERE recipient_id = ? AND read_at IS NULL;
  `;
}

export function buildMarkNotificationReadSql() {
  return `
    UPDATE notifications
    SET read_at = COALESCE(read_at, now())
    WHERE id = ? AND recipient_id = ?;
  `;
}

export function buildMarkAllNotificationsReadSql() {
  return `
    UPDATE notifications
    SET read_at = COALESCE(read_at, now())
    WHERE recipient_id = ? AND read_at IS NULL;
  `;
}
