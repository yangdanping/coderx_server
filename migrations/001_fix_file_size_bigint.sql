-- ============================================================
-- 001_fix_file_size_bigint.sql
--
-- 目的：file.size 从 integer 升级到 bigint
--
-- 背景：
--   integer 上限约 2.1 GB (2^31 - 1 = 2147483647 字节)。
--   4K 视频或较长时长视频很容易超过该限制，届时 INSERT 会直接报
--   "integer out of range" 导致上传失败。
--   bigint 上限为 9.2 EB (2^63 - 1)，远大于任何实际文件尺寸。
--
-- 影响：
--   - 列宽从 4 字节变为 8 字节，单行仅增加 4 字节，整表可忽略
--   - ALTER COLUMN TYPE 在 PG 里需要全表重写，大表会锁表较久
--     （file 表当前量级较小，预计秒级完成）
--
-- 注意：
--   PG 14+ 的 ALTER COLUMN TYPE int -> bigint 依然会重写表，但不需要
--   USING 表达式（隐式强转安全）。如果 file 表数据量已达千万级，建议
--   改走 "新增 size_big 列 + 双写 + 数据回填 + 切流 + 删旧列" 的灰度方案。
-- ============================================================

BEGIN;

ALTER TABLE file
    ALTER COLUMN size TYPE bigint;

COMMENT ON COLUMN file.size IS '文件大小（字节），bigint 支持超大文件';

COMMIT;
