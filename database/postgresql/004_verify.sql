-- PostgreSQL stage 1 verification queries for coderx.
-- This file is read-only: it only inspects schema objects and loaded data.

-- ---------------------------------------------------------------------------
-- 1) Table presence: expected base tables = 17
-- ---------------------------------------------------------------------------
WITH expected(table_name) AS (
  VALUES
    ('article'),
    ('article_collect'),
    ('article_history'),
    ('article_like'),
    ('article_tag'),
    ('avatar'),
    ('collect'),
    ('comment'),
    ('comment_like'),
    ('file'),
    ('image_meta'),
    ('profile'),
    ('report'),
    ('tag'),
    ('user'),
    ('user_follow'),
    ('video_meta')
)
SELECT
  table_name,
  to_regclass(format('public.%I', table_name)) IS NOT NULL AS present
FROM expected
ORDER BY table_name;

WITH expected(table_name) AS (
  VALUES
    ('article'),
    ('article_collect'),
    ('article_history'),
    ('article_like'),
    ('article_tag'),
    ('avatar'),
    ('collect'),
    ('comment'),
    ('comment_like'),
    ('file'),
    ('image_meta'),
    ('profile'),
    ('report'),
    ('tag'),
    ('user'),
    ('user_follow'),
    ('video_meta')
)
SELECT
  count(*) FILTER (WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL) AS present_table_count,
  count(*) AS expected_table_count
FROM expected;

-- ---------------------------------------------------------------------------
-- 2) Identity columns: every single-column id primary key should be identity
-- ---------------------------------------------------------------------------
WITH expected(table_name) AS (
  VALUES
    ('article'),
    ('article_history'),
    ('avatar'),
    ('collect'),
    ('comment'),
    ('file'),
    ('image_meta'),
    ('profile'),
    ('report'),
    ('tag'),
    ('user'),
    ('video_meta')
)
SELECT
  table_name,
  EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = expected.table_name
      AND c.column_name = 'id'
      AND c.is_identity = 'YES'
  ) AS id_is_identity
FROM expected
ORDER BY table_name;

-- ---------------------------------------------------------------------------
-- 3) Trigger presence: expected update_at triggers = 17
-- ---------------------------------------------------------------------------
WITH expected(trigger_name) AS (
  VALUES
    ('article_set_update_at'),
    ('article_collect_set_update_at'),
    ('article_history_set_update_at'),
    ('article_like_set_update_at'),
    ('article_tag_set_update_at'),
    ('avatar_set_update_at'),
    ('collect_set_update_at'),
    ('comment_set_update_at'),
    ('comment_like_set_update_at'),
    ('file_set_update_at'),
    ('image_meta_set_update_at'),
    ('profile_set_update_at'),
    ('report_set_update_at'),
    ('tag_set_update_at'),
    ('user_set_update_at'),
    ('user_follow_set_update_at'),
    ('video_meta_set_update_at')
)
SELECT
  trigger_name,
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND t.tgname = expected.trigger_name
      AND NOT t.tgisinternal
  ) AS present
FROM expected
ORDER BY trigger_name;

-- ---------------------------------------------------------------------------
-- 4) Required secondary indexes from 003_indexes.sql
-- ---------------------------------------------------------------------------
WITH expected(index_name) AS (
  VALUES
    ('article_user_id_idx'),
    ('article_create_at_idx'),
    ('article_collect_collect_id_idx'),
    ('article_history_article_id_idx'),
    ('article_history_create_at_idx'),
    ('article_history_user_id_update_at_idx'),
    ('article_like_user_id_idx'),
    ('article_tag_tag_id_idx'),
    ('avatar_user_id_idx'),
    ('collect_user_id_idx'),
    ('comment_user_id_idx'),
    ('comment_comment_id_create_at_id_idx'),
    ('comment_reply_id_idx'),
    ('comment_article_id_comment_id_idx'),
    ('comment_article_root_create_at_idx'),
    ('comment_user_id_create_at_idx'),
    ('comment_like_user_id_idx'),
    ('file_user_id_idx'),
    ('file_file_type_idx'),
    ('file_article_id_file_type_idx'),
    ('file_orphan_cleanup_idx'),
    ('image_meta_is_cover_idx'),
    ('profile_email_idx'),
    ('report_user_id_idx'),
    ('report_article_id_idx'),
    ('report_comment_id_idx'),
    ('user_follow_follower_id_idx'),
    ('video_meta_transcode_status_idx')
)
SELECT
  index_name,
  EXISTS (
    SELECT 1
    FROM pg_indexes i
    WHERE i.schemaname = 'public'
      AND i.indexname = expected.index_name
  ) AS present
FROM expected
ORDER BY index_name;

-- ---------------------------------------------------------------------------
-- 5) Inspect key constraints and PG-specific replacements
-- ---------------------------------------------------------------------------
SELECT
  conrelid::regclass AS table_name,
  contype,
  conname,
  pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid IN (
  'public.article'::regclass,
  'public.article_history'::regclass,
  'public.file'::regclass,
  'public.profile'::regclass,
  'public."user"'::regclass,
  'public.video_meta'::regclass
)
  AND contype IN ('c', 'u', 'f')
ORDER BY table_name, contype, conname;

-- ---------------------------------------------------------------------------
-- 6) Post-load row counts: compare these numbers with MySQL after import
-- ---------------------------------------------------------------------------
SELECT 'article' AS table_name, count(*) AS row_count FROM public.article
UNION ALL
SELECT 'article_collect', count(*) FROM public.article_collect
UNION ALL
SELECT 'article_history', count(*) FROM public.article_history
UNION ALL
SELECT 'article_like', count(*) FROM public.article_like
UNION ALL
SELECT 'article_tag', count(*) FROM public.article_tag
UNION ALL
SELECT 'avatar', count(*) FROM public.avatar
UNION ALL
SELECT 'collect', count(*) FROM public.collect
UNION ALL
SELECT 'comment', count(*) FROM public.comment
UNION ALL
SELECT 'comment_like', count(*) FROM public.comment_like
UNION ALL
SELECT 'file', count(*) FROM public.file
UNION ALL
SELECT 'image_meta', count(*) FROM public.image_meta
UNION ALL
SELECT 'profile', count(*) FROM public.profile
UNION ALL
SELECT 'report', count(*) FROM public.report
UNION ALL
SELECT 'tag', count(*) FROM public.tag
UNION ALL
SELECT '"user"', count(*) FROM public."user"
UNION ALL
SELECT 'user_follow', count(*) FROM public.user_follow
UNION ALL
SELECT 'video_meta', count(*) FROM public.video_meta
ORDER BY table_name;

-- ---------------------------------------------------------------------------
-- 7) Post-load orphan checks: each result should be zero
-- ---------------------------------------------------------------------------
SELECT 'article.user_id -> user.id' AS check_name, count(*) AS orphan_rows
FROM public.article a
LEFT JOIN public."user" u ON u.id = a.user_id
WHERE a.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'collect.user_id -> user.id', count(*)
FROM public.collect c
LEFT JOIN public."user" u ON u.id = c.user_id
WHERE c.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'avatar.user_id -> user.id', count(*)
FROM public.avatar a
LEFT JOIN public."user" u ON u.id = a.user_id
WHERE a.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'profile.user_id -> user.id', count(*)
FROM public.profile p
LEFT JOIN public."user" u ON u.id = p.user_id
WHERE p.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'article_collect.article_id -> article.id', count(*)
FROM public.article_collect ac
LEFT JOIN public.article a ON a.id = ac.article_id
WHERE ac.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'article_collect.collect_id -> collect.id', count(*)
FROM public.article_collect ac
LEFT JOIN public.collect c ON c.id = ac.collect_id
WHERE ac.collect_id IS NOT NULL AND c.id IS NULL
UNION ALL
SELECT 'article_history.user_id -> user.id', count(*)
FROM public.article_history ah
LEFT JOIN public."user" u ON u.id = ah.user_id
WHERE ah.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'article_history.article_id -> article.id', count(*)
FROM public.article_history ah
LEFT JOIN public.article a ON a.id = ah.article_id
WHERE ah.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'article_like.article_id -> article.id', count(*)
FROM public.article_like al
LEFT JOIN public.article a ON a.id = al.article_id
WHERE al.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'article_like.user_id -> user.id', count(*)
FROM public.article_like al
LEFT JOIN public."user" u ON u.id = al.user_id
WHERE al.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'article_tag.article_id -> article.id', count(*)
FROM public.article_tag at
LEFT JOIN public.article a ON a.id = at.article_id
WHERE at.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'article_tag.tag_id -> tag.id', count(*)
FROM public.article_tag at
LEFT JOIN public.tag t ON t.id = at.tag_id
WHERE at.tag_id IS NOT NULL AND t.id IS NULL
UNION ALL
SELECT 'comment.user_id -> user.id', count(*)
FROM public.comment c
LEFT JOIN public."user" u ON u.id = c.user_id
WHERE c.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'comment.article_id -> article.id', count(*)
FROM public.comment c
LEFT JOIN public.article a ON a.id = c.article_id
WHERE c.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'comment.comment_id -> comment.id', count(*)
FROM public.comment c
LEFT JOIN public.comment parent ON parent.id = c.comment_id
WHERE c.comment_id IS NOT NULL AND parent.id IS NULL
UNION ALL
SELECT 'comment.reply_id -> comment.id', count(*)
FROM public.comment c
LEFT JOIN public.comment reply ON reply.id = c.reply_id
WHERE c.reply_id IS NOT NULL AND reply.id IS NULL
UNION ALL
SELECT 'comment_like.comment_id -> comment.id', count(*)
FROM public.comment_like cl
LEFT JOIN public.comment c ON c.id = cl.comment_id
WHERE cl.comment_id IS NOT NULL AND c.id IS NULL
UNION ALL
SELECT 'comment_like.user_id -> user.id', count(*)
FROM public.comment_like cl
LEFT JOIN public."user" u ON u.id = cl.user_id
WHERE cl.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'file.user_id -> user.id', count(*)
FROM public.file f
LEFT JOIN public."user" u ON u.id = f.user_id
WHERE f.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'file.article_id -> article.id', count(*)
FROM public.file f
LEFT JOIN public.article a ON a.id = f.article_id
WHERE f.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'image_meta.file_id -> file.id', count(*)
FROM public.image_meta im
LEFT JOIN public.file f ON f.id = im.file_id
WHERE im.file_id IS NOT NULL AND f.id IS NULL
UNION ALL
SELECT 'report.user_id -> user.id', count(*)
FROM public.report r
LEFT JOIN public."user" u ON u.id = r.user_id
WHERE r.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'report.article_id -> article.id', count(*)
FROM public.report r
LEFT JOIN public.article a ON a.id = r.article_id
WHERE r.article_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'report.comment_id -> comment.id', count(*)
FROM public.report r
LEFT JOIN public.comment c ON c.id = r.comment_id
WHERE r.comment_id IS NOT NULL AND c.id IS NULL
UNION ALL
SELECT 'user_follow.user_id -> user.id', count(*)
FROM public.user_follow uf
LEFT JOIN public."user" u ON u.id = uf.user_id
WHERE uf.user_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'user_follow.follower_id -> user.id', count(*)
FROM public.user_follow uf
LEFT JOIN public."user" u ON u.id = uf.follower_id
WHERE uf.follower_id IS NOT NULL AND u.id IS NULL
UNION ALL
SELECT 'video_meta.file_id -> file.id', count(*)
FROM public.video_meta vm
LEFT JOIN public.file f ON f.id = vm.file_id
WHERE vm.file_id IS NOT NULL AND f.id IS NULL;

-- ---------------------------------------------------------------------------
-- 8) Post-load semantic checks: these should also be zero
-- ---------------------------------------------------------------------------
SELECT 'comment.comment_id article mismatch' AS check_name, count(*) AS invalid_rows
FROM public.comment c
JOIN public.comment parent ON parent.id = c.comment_id
WHERE c.comment_id IS NOT NULL
  AND c.article_id IS DISTINCT FROM parent.article_id
UNION ALL
SELECT 'comment.reply_id article mismatch', count(*)
FROM public.comment c
JOIN public.comment reply ON reply.id = c.reply_id
WHERE c.reply_id IS NOT NULL
  AND c.article_id IS DISTINCT FROM reply.article_id
UNION ALL
SELECT 'image_meta.file_id must point to image file', count(*)
FROM public.image_meta im
JOIN public.file f ON f.id = im.file_id
WHERE f.file_type IS DISTINCT FROM 'image'
UNION ALL
SELECT 'video_meta.file_id must point to video file', count(*)
FROM public.video_meta vm
JOIN public.file f ON f.id = vm.file_id
WHERE f.file_type IS DISTINCT FROM 'video';

-- At most one cover image per article should exist.
SELECT
  f.article_id,
  count(*) AS cover_count
FROM public.file f
JOIN public.image_meta im ON im.file_id = f.id
WHERE f.article_id IS NOT NULL
  AND im.is_cover IS TRUE
GROUP BY f.article_id
HAVING count(*) > 1
ORDER BY f.article_id;

-- ---------------------------------------------------------------------------
-- 9) Post-load identity alignment: compare max(id) with pg_sequences.last_value
-- ---------------------------------------------------------------------------
WITH identity_state AS (
  SELECT 'article' AS table_name, pg_get_serial_sequence('public.article', 'id') AS sequence_name, coalesce(max(id), 0) AS max_id FROM public.article
  UNION ALL
  SELECT 'article_history', pg_get_serial_sequence('public.article_history', 'id'), coalesce(max(id), 0) FROM public.article_history
  UNION ALL
  SELECT 'avatar', pg_get_serial_sequence('public.avatar', 'id'), coalesce(max(id), 0) FROM public.avatar
  UNION ALL
  SELECT 'collect', pg_get_serial_sequence('public.collect', 'id'), coalesce(max(id), 0) FROM public.collect
  UNION ALL
  SELECT 'comment', pg_get_serial_sequence('public.comment', 'id'), coalesce(max(id), 0) FROM public.comment
  UNION ALL
  SELECT 'file', pg_get_serial_sequence('public.file', 'id'), coalesce(max(id), 0) FROM public.file
  UNION ALL
  SELECT 'image_meta', pg_get_serial_sequence('public.image_meta', 'id'), coalesce(max(id), 0) FROM public.image_meta
  UNION ALL
  SELECT 'profile', pg_get_serial_sequence('public.profile', 'id'), coalesce(max(id), 0) FROM public.profile
  UNION ALL
  SELECT 'report', pg_get_serial_sequence('public.report', 'id'), coalesce(max(id), 0) FROM public.report
  UNION ALL
  SELECT 'tag', pg_get_serial_sequence('public.tag', 'id'), coalesce(max(id), 0) FROM public.tag
  UNION ALL
  SELECT '"user"', pg_get_serial_sequence('public."user"', 'id'), coalesce(max(id), 0) FROM public."user"
  UNION ALL
  SELECT 'video_meta', pg_get_serial_sequence('public.video_meta', 'id'), coalesce(max(id), 0) FROM public.video_meta
)
SELECT
  i.table_name,
  i.sequence_name,
  i.max_id,
  s.last_value AS sequence_last_value
FROM identity_state i
LEFT JOIN pg_sequences s
  ON s.schemaname = split_part(i.sequence_name, '.', 1)
 AND s.sequencename = split_part(i.sequence_name, '.', 2)
ORDER BY i.table_name;

-- ---------------------------------------------------------------------------
-- 10) Timezone sanity check: compare UTC and Asia/Shanghai views after import
-- ---------------------------------------------------------------------------
SELECT
  'article' AS table_name,
  min(create_at) AS min_create_at_utc,
  max(create_at) AS max_create_at_utc,
  min(create_at AT TIME ZONE 'Asia/Shanghai') AS min_create_at_shanghai,
  max(create_at AT TIME ZONE 'Asia/Shanghai') AS max_create_at_shanghai,
  min(update_at) AS min_update_at_utc,
  max(update_at) AS max_update_at_utc
FROM public.article
UNION ALL
SELECT
  'comment',
  min(create_at),
  max(create_at),
  min(create_at AT TIME ZONE 'Asia/Shanghai'),
  max(create_at AT TIME ZONE 'Asia/Shanghai'),
  min(update_at),
  max(update_at)
FROM public.comment
UNION ALL
SELECT
  'file',
  min(create_at),
  max(create_at),
  min(create_at AT TIME ZONE 'Asia/Shanghai'),
  max(create_at AT TIME ZONE 'Asia/Shanghai'),
  min(update_at),
  max(update_at)
FROM public.file
UNION ALL
SELECT
  '"user"',
  min(create_at),
  max(create_at),
  min(create_at AT TIME ZONE 'Asia/Shanghai'),
  max(create_at AT TIME ZONE 'Asia/Shanghai'),
  min(update_at),
  max(update_at)
FROM public."user"
ORDER BY table_name;
