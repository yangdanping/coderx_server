-- ============================================================
-- 003_update_notifications_cooldown_index.sql
--
-- 目的：兼容已经执行过旧版 002_create_notifications.sql 的环境。
--
-- 旧版 002 曾使用永久唯一约束阻止同一人对同一文章再次产生通知；
-- 新规则改为“冷却时间内去噪，超过冷却时间可产生新通知”，因此需要
-- 删除旧唯一约束，并补建按业务键查最近通知的索引。
-- ============================================================

BEGIN;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_article_like_dedupe_key;

ALTER TABLE notifications
    ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
    ALTER COLUMN last_occurred_at SET DEFAULT clock_timestamp();

CREATE INDEX IF NOT EXISTS idx_notifications_article_like_cooldown_lookup
    ON notifications (recipient_id, actor_id, type, target_type, target_id, created_at DESC);

COMMIT;
