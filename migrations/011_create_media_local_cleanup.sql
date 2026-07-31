-- ============================================================
-- 011_create_media_local_cleanup.sql
--
-- 目的：在业务 file 行删除前持久化本地文件名，使 EC2 unlink 在
-- 崩溃/EIO 后仍可幂等重试，而不是失去最后一份可追踪清单。
-- ============================================================

BEGIN;

CREATE TABLE media_local_cleanup (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    storage_area TEXT NOT NULL
        CHECK (storage_area IN ('image', 'video')),
    filename TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT media_local_cleanup_safe_filename_check CHECK (
        char_length(filename) BETWEEN 1 AND 255
        AND filename = btrim(filename)
        AND filename NOT IN ('.', '..')
        AND position('/' IN filename) = 0
        AND position(E'\\' IN filename) = 0
    ),
    CONSTRAINT media_local_cleanup_area_filename_uidx
        UNIQUE (storage_area, filename)
);

CREATE INDEX media_local_cleanup_retry_idx
    ON media_local_cleanup (updated_at, id);

COMMENT ON TABLE media_local_cleanup IS
    '业务媒体删除后仍待从 EC2 磁盘幂等回收的文件名 outbox';

COMMIT;
