-- PostgreSQL stage 1 trigger helpers for coderx.
-- This file restores the MySQL `ON UPDATE CURRENT_TIMESTAMP` behavior.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_update_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.update_at = clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS article_set_update_at ON public.article;
CREATE TRIGGER article_set_update_at
BEFORE UPDATE ON public.article
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS article_collect_set_update_at ON public.article_collect;
CREATE TRIGGER article_collect_set_update_at
BEFORE UPDATE ON public.article_collect
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS article_history_set_update_at ON public.article_history;
CREATE TRIGGER article_history_set_update_at
BEFORE UPDATE ON public.article_history
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS article_like_set_update_at ON public.article_like;
CREATE TRIGGER article_like_set_update_at
BEFORE UPDATE ON public.article_like
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS article_tag_set_update_at ON public.article_tag;
CREATE TRIGGER article_tag_set_update_at
BEFORE UPDATE ON public.article_tag
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS avatar_set_update_at ON public.avatar;
CREATE TRIGGER avatar_set_update_at
BEFORE UPDATE ON public.avatar
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS collect_set_update_at ON public.collect;
CREATE TRIGGER collect_set_update_at
BEFORE UPDATE ON public.collect
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS comment_set_update_at ON public.comment;
CREATE TRIGGER comment_set_update_at
BEFORE UPDATE ON public.comment
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS comment_like_set_update_at ON public.comment_like;
CREATE TRIGGER comment_like_set_update_at
BEFORE UPDATE ON public.comment_like
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS file_set_update_at ON public.file;
CREATE TRIGGER file_set_update_at
BEFORE UPDATE ON public.file
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS image_meta_set_update_at ON public.image_meta;
CREATE TRIGGER image_meta_set_update_at
BEFORE UPDATE ON public.image_meta
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS profile_set_update_at ON public.profile;
CREATE TRIGGER profile_set_update_at
BEFORE UPDATE ON public.profile
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS report_set_update_at ON public.report;
CREATE TRIGGER report_set_update_at
BEFORE UPDATE ON public.report
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS tag_set_update_at ON public.tag;
CREATE TRIGGER tag_set_update_at
BEFORE UPDATE ON public.tag
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS user_set_update_at ON public."user";
CREATE TRIGGER user_set_update_at
BEFORE UPDATE ON public."user"
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS user_follow_set_update_at ON public.user_follow;
CREATE TRIGGER user_follow_set_update_at
BEFORE UPDATE ON public.user_follow
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

DROP TRIGGER IF EXISTS video_meta_set_update_at ON public.video_meta;
CREATE TRIGGER video_meta_set_update_at
BEFORE UPDATE ON public.video_meta
FOR EACH ROW
EXECUTE FUNCTION public.set_update_at();

COMMIT;
