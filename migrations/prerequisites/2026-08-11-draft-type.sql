-- Shared article/Flow draft discriminator and type-aware active uniqueness.
-- Existing rows are article drafts; the constant default makes the backfill metadata-only on PostgreSQL.

BEGIN;

ALTER TABLE draft
  ADD COLUMN draft_type text NOT NULL DEFAULT 'article';

ALTER TABLE draft
  ADD CONSTRAINT draft_type_check
  CHECK (draft_type IN ('article', 'flow'));

ALTER TABLE draft
  ADD CONSTRAINT draft_flow_target_check
  CHECK (
    draft_type = 'article'
    OR (
      draft_type = 'flow'
      AND article_id IS NULL
      AND consumed_article_id IS NULL
    )
  );

COMMENT ON COLUMN draft.draft_type IS '草稿业务类型：article=文章草稿，flow=Flow 草稿';

DROP INDEX IF EXISTS draft_user_article_uq;
DROP INDEX IF EXISTS draft_user_new_uq;
DROP INDEX IF EXISTS draft_user_new_article_uq;
DROP INDEX IF EXISTS draft_user_flow_uq;

CREATE UNIQUE INDEX draft_user_article_uq
  ON draft (user_id, article_id)
  WHERE draft_type = 'article'
    AND article_id IS NOT NULL
    AND status = 'active';

CREATE UNIQUE INDEX draft_user_new_article_uq
  ON draft (user_id)
  WHERE draft_type = 'article'
    AND article_id IS NULL
    AND status = 'active';

CREATE UNIQUE INDEX draft_user_flow_uq
  ON draft (user_id)
  WHERE draft_type = 'flow'
    AND status = 'active';

COMMIT;
