-- PostgreSQL stage 1 secondary indexes for coderx.
-- Primary keys and unique constraints are created in 001_schema.sql.

BEGIN;

CREATE INDEX IF NOT EXISTS article_user_id_idx
  ON public.article (user_id);

CREATE INDEX IF NOT EXISTS article_create_at_idx
  ON public.article (create_at DESC);

CREATE INDEX IF NOT EXISTS article_collect_collect_id_idx
  ON public.article_collect (collect_id);

CREATE INDEX IF NOT EXISTS article_history_article_id_idx
  ON public.article_history (article_id);

CREATE INDEX IF NOT EXISTS article_history_create_at_idx
  ON public.article_history (create_at);

CREATE INDEX IF NOT EXISTS article_history_user_id_update_at_idx
  ON public.article_history (user_id, update_at DESC);

CREATE INDEX IF NOT EXISTS article_like_user_id_idx
  ON public.article_like (user_id);

CREATE INDEX IF NOT EXISTS article_tag_tag_id_idx
  ON public.article_tag (tag_id);

CREATE INDEX IF NOT EXISTS avatar_user_id_idx
  ON public.avatar (user_id);

CREATE INDEX IF NOT EXISTS collect_user_id_idx
  ON public.collect (user_id);

CREATE INDEX IF NOT EXISTS comment_user_id_idx
  ON public.comment (user_id);

CREATE INDEX IF NOT EXISTS comment_comment_id_create_at_id_idx
  ON public.comment (comment_id, create_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS comment_reply_id_idx
  ON public.comment (reply_id);

CREATE INDEX IF NOT EXISTS comment_article_id_comment_id_idx
  ON public.comment (article_id, comment_id);

CREATE INDEX IF NOT EXISTS comment_article_root_create_at_idx
  ON public.comment (article_id, create_at DESC, id DESC)
  WHERE comment_id IS NULL;

CREATE INDEX IF NOT EXISTS comment_user_id_create_at_idx
  ON public.comment (user_id, create_at DESC);

CREATE INDEX IF NOT EXISTS comment_like_user_id_idx
  ON public.comment_like (user_id);

CREATE INDEX IF NOT EXISTS file_user_id_idx
  ON public.file (user_id);

CREATE INDEX IF NOT EXISTS file_file_type_idx
  ON public.file (file_type);

CREATE INDEX IF NOT EXISTS file_article_id_file_type_idx
  ON public.file (article_id, file_type);

CREATE INDEX IF NOT EXISTS file_orphan_cleanup_idx
  ON public.file (file_type, create_at)
  WHERE article_id IS NULL;

CREATE INDEX IF NOT EXISTS image_meta_is_cover_idx
  ON public.image_meta (is_cover);

CREATE INDEX IF NOT EXISTS profile_email_idx
  ON public.profile (email);

CREATE INDEX IF NOT EXISTS report_user_id_idx
  ON public.report (user_id);

CREATE INDEX IF NOT EXISTS report_article_id_idx
  ON public.report (article_id);

CREATE INDEX IF NOT EXISTS report_comment_id_idx
  ON public.report (comment_id);

CREATE INDEX IF NOT EXISTS user_follow_follower_id_idx
  ON public.user_follow (follower_id);

CREATE INDEX IF NOT EXISTS video_meta_transcode_status_idx
  ON public.video_meta (transcode_status);

COMMIT;
