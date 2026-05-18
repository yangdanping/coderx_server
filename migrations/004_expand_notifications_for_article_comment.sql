-- ============================================================
-- 004_expand_notifications_for_article_comment.sql
--
-- 目的：把通知事实表从文章点赞扩展到文章评论通知。
-- ============================================================

BEGIN;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('article_like', 'article_comment'));

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_target_type_check;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_target_type_check
    CHECK (target_type IN ('article'));

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS comment_id BIGINT REFERENCES comment(id) ON DELETE SET NULL;

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_article_target_consistency;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_article_target_consistency CHECK (
        target_type <> 'article'
        OR article_id = target_id
    );

CREATE INDEX IF NOT EXISTS idx_notifications_comment_id
    ON notifications (comment_id);

COMMENT ON COLUMN notifications.comment_id IS '评论相关通知的评论 ID，评论删除后允许置空';
COMMENT ON COLUMN notifications.metadata IS '通知发生时的轻量展示快照，例如评论摘要';

COMMIT;
