-- ============================================================
-- 010_create_media_object.sql
--
-- 目的：记录逻辑媒体文件在本地磁盘或 R2 中的物理对象。
-- ============================================================

BEGIN;

CREATE TABLE media_object (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id BIGINT NOT NULL
        REFERENCES file(id) ON DELETE CASCADE,
    provider TEXT NOT NULL
        CHECK (provider IN ('local', 'r2')),
    variant TEXT NOT NULL
        CHECK (variant IN ('original', 'small', 'video', 'poster')),
    object_key TEXT,
    local_path TEXT,
    size_bytes BIGINT NOT NULL
        CHECK (size_bytes >= 0),
    sha256 CHAR(64) NOT NULL
        CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ready', 'deleting', 'failed')),
    last_error TEXT,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT media_object_location_check CHECK (
        (
            provider = 'local'
            AND local_path IS NOT NULL
            AND object_key IS NULL
        )
        OR
        (
            provider = 'r2'
            AND object_key IS NOT NULL
            AND local_path IS NULL
        )
    ),
    CONSTRAINT media_object_file_provider_variant_uidx
        UNIQUE (file_id, provider, variant)
);

CREATE UNIQUE INDEX media_object_r2_key_uidx
    ON media_object (object_key)
    WHERE provider = 'r2';

CREATE UNIQUE INDEX media_object_local_path_uidx
    ON media_object (local_path)
    WHERE provider = 'local';

CREATE INDEX media_object_file_id_idx
    ON media_object (file_id);

CREATE INDEX media_object_provider_status_idx
    ON media_object (provider, status);

COMMENT ON TABLE media_object IS
    '逻辑 file 在本地磁盘或 R2 中的物理对象；迁移期允许两份 ready 副本并存';

COMMIT;
