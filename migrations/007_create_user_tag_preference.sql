-- ============================================================
-- 007_create_user_tag_preference.sql
--
-- 目的：保存每个用户独立的专栏标签顺序；全局 tag 字典保持无用户状态。
-- ============================================================

BEGIN;

CREATE TABLE user_tag_preference (
    user_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,
    sort_order INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT user_tag_preference_pkey
        PRIMARY KEY (user_id, tag_id),
    CONSTRAINT user_tag_preference_user_sort_order_key
        UNIQUE (user_id, sort_order),
    CONSTRAINT user_tag_preference_sort_order_check
        CHECK (sort_order >= 0),
    CONSTRAINT user_tag_preference_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES "user"(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT user_tag_preference_tag_id_fkey
        FOREIGN KEY (tag_id) REFERENCES tag(id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

-- 联合主键已覆盖 user_id 查询；为另一侧外键补索引，避免删除 tag 时全表扫描。
CREATE INDEX user_tag_preference_tag_id_idx
    ON user_tag_preference (tag_id);

COMMENT ON TABLE user_tag_preference IS '用户对全局文章标签的个性化顺序';
COMMENT ON COLUMN user_tag_preference.sort_order IS '从 0 开始的用户内标签顺序';

COMMIT;
