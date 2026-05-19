-- ============================================================
-- 005_expand_notifications_for_comment_reply.sql
--
-- 目的：把通知事实表从文章评论扩展到评论回复通知。
-- ============================================================

BEGIN;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('article_like', 'article_comment', 'comment_reply'));

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_target_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_target_type_check
    CHECK (target_type IN ('article'));

COMMIT;
