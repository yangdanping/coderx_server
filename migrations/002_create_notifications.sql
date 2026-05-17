-- ============================================================
-- 002_create_notifications.sql
--
-- 目的：新增站内通知事实表，首个消费者为文章点赞通知。
--
-- 规则：
--   - PostgreSQL 保存通知历史事实，Redis/Socket.IO 只负责实时送达。
--   - 同一 actor 对同一 article 的点赞通知允许保留多条历史。
--   - 是否创建新通知由后端服务按冷却时间判断，冷却时间内不插入，
--     超过冷却时间后插入新通知，新旧通知互不干扰。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_id BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    actor_id BIGINT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('article_like')),
    target_type TEXT NOT NULL CHECK (target_type IN ('article')),
    target_id BIGINT NOT NULL,
    article_id BIGINT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT notifications_article_target_consistency CHECK (
        type <> 'article_like'
        OR (target_type = 'article' AND article_id = target_id)
    )
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id
    ON notifications (recipient_id);

CREATE INDEX IF NOT EXISTS idx_notifications_actor_id
    ON notifications (actor_id);

CREATE INDEX IF NOT EXISTS idx_notifications_article_id
    ON notifications (article_id);

CREATE INDEX IF NOT EXISTS idx_notifications_article_like_cooldown_lookup
    ON notifications (recipient_id, actor_id, type, target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created_at
    ON notifications (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread_by_recipient
    ON notifications (recipient_id)
    WHERE read_at IS NULL;

COMMENT ON TABLE notifications IS '站内通知事实表，首期用于文章点赞通知';
COMMENT ON COLUMN notifications.read_at IS '为空表示未读，非空表示已读时间';

COMMIT;
