-- ============================================================
-- 006_expand_notifications_for_comment_like.sql
--
-- 目的：扩展评论点赞通知，并允许通知直接以评论为业务目标。
-- ============================================================

BEGIN;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('article_like', 'article_comment', 'comment_reply', 'follow', 'comment_like'));

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_target_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_target_type_check
    CHECK (target_type IN ('article', 'user', 'comment'));

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_article_target_consistency;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_target_consistency;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_target_consistency CHECK (
        (
            type IN ('article_like', 'article_comment', 'comment_reply')
            AND target_type = 'article'
            AND article_id = target_id
        )
        OR (
            type = 'follow'
            AND target_type = 'user'
            AND target_id = recipient_id
            AND article_id IS NULL
            AND comment_id IS NULL
        )
        OR (
            type = 'comment_like'
            AND target_type = 'comment'
            AND target_id = comment_id
            AND article_id IS NOT NULL
            AND comment_id IS NOT NULL
        )
    );

COMMIT;
