-- Reset data in the PostgreSQL shadow database while keeping schema, triggers, and indexes.

BEGIN;

TRUNCATE TABLE
  public.video_meta,
  public.image_meta,
  public.comment_like,
  public.article_collect,
  public.article_history,
  public.article_like,
  public.article_tag,
  public.report,
  public.comment,
  public.file,
  public.user_follow,
  public.profile,
  public.avatar,
  public.collect,
  public.article,
  public.tag,
  public."user"
RESTART IDENTITY CASCADE;

COMMIT;
