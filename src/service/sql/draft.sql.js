function buildUpsertDraftSql({ hasArticleId }) {
  const conflictTarget = hasArticleId
    ? "ON CONFLICT (user_id, article_id) WHERE article_id IS NOT NULL AND status = 'active'"
    : "ON CONFLICT (user_id) WHERE article_id IS NULL AND status = 'active'";

  return `
    INSERT INTO draft (user_id, article_id, title, content, meta, version)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 1)
    ${conflictTarget}
    DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      meta = EXCLUDED.meta,
      version = draft.version + 1,
      update_at = NOW(),
      status = 'active',
      consumed_at = NULL,
      discarded_at = NULL,
      consumed_article_id = NULL
    WHERE draft.version = $6
    RETURNING
      id,
      user_id AS "userId",
      article_id AS "articleId",
      title,
      content,
      meta,
      version,
      create_at AS "createAt",
      update_at AS "updateAt";
  `;
}

function buildFindDraftSql({ hasArticleId }) {
  if (hasArticleId) {
    return `
      SELECT
        id,
        user_id AS "userId",
        article_id AS "articleId",
        title,
        content,
        meta,
        version,
        create_at AS "createAt",
        update_at AS "updateAt"
      FROM draft
      WHERE user_id = $1 AND article_id = $2 AND status = 'active'
      LIMIT 1;
    `;
  }

  return `
    SELECT
      id,
      user_id AS "userId",
      article_id AS "articleId",
      title,
      content,
      meta,
      version,
      create_at AS "createAt",
      update_at AS "updateAt"
    FROM draft
    WHERE user_id = $1 AND article_id IS NULL AND status = 'active'
    LIMIT 1;
  `;
}

/** 按 draftId 锁定可消费的 active 草稿（发布/更新文章事务内使用，FOR UPDATE） */
function buildFindDraftForConsumeSql({ hasArticleId }) {
  const selectList = `
      SELECT
        id,
        user_id AS "userId",
        article_id AS "articleId",
        title,
        content,
        meta,
        version,
        create_at AS "createAt",
        update_at AS "updateAt"
      FROM draft
      WHERE id = $1 AND user_id = $2 AND status = 'active'`;

  if (hasArticleId) {
    return `${selectList} AND article_id = $3 FOR UPDATE;`;
  }

  return `${selectList} AND article_id IS NULL FOR UPDATE;`;
}

function buildCheckOwnedArticleSql() {
  return `
    SELECT id
    FROM article
    WHERE id = $1 AND user_id = $2
    LIMIT 1;
  `;
}

function buildValidateDraftFilesSql() {
  return `
    SELECT
      id,
      article_id AS "articleId"
    FROM file
    WHERE user_id = $1
      AND id = ANY($2::bigint[])
      AND (article_id IS NULL OR article_id = $3)
      AND (draft_id IS NULL OR draft_id = $4);
  `;
}

function buildClearRemovedDraftFilesSql() {
  return `
    UPDATE file SET draft_id = NULL
    WHERE user_id = $1
      AND draft_id = $2
      AND NOT (id = ANY($3::bigint[]));
  `;
}

function buildBindDraftFilesSql() {
  return `
    UPDATE file SET draft_id = $2
    WHERE user_id = $1
      AND id = ANY($3::bigint[]);
  `;
}

function buildDiscardDraftSql() {
  return `
    UPDATE draft
    SET
      status = 'discarded',
      discarded_at = NOW(),
      consumed_at = NULL,
      consumed_article_id = NULL,
      update_at = NOW()
    WHERE id = $1 AND user_id = $2 AND status = 'active'
    RETURNING
      id,
      user_id AS "userId",
      article_id AS "articleId",
      title,
      content,
      meta,
      version,
      create_at AS "createAt",
      update_at AS "updateAt";
  `;
}

function buildConsumeDraftSql() {
  return `
    UPDATE draft
    SET
      status = 'consumed',
      consumed_at = NOW(),
      discarded_at = NULL,
      consumed_article_id = $3,
      update_at = NOW()
    WHERE id = $1 AND user_id = $2 AND status = 'active'
    RETURNING
      id,
      user_id AS "userId",
      article_id AS "articleId",
      title,
      content,
      meta,
      version,
      create_at AS "createAt",
      update_at AS "updateAt";
  `;
}

function normalizeDeleteDraftRetentionUnit(unit) {
  const normalized = String(unit || 'DAY').toUpperCase();
  if (!['SECOND', 'HOUR', 'DAY'].includes(normalized)) {
    throw new Error(`Unsupported retention unit: ${unit}`);
  }
  return normalized;
}

function buildDeleteDraftCutoffExpression(placeholder, unit = 'DAY') {
  const normalizedUnit = normalizeDeleteDraftRetentionUnit(unit);

  switch (normalizedUnit) {
    case 'SECOND':
      return `NOW() - (${placeholder} * INTERVAL '1 second')`;
    case 'HOUR':
      return `NOW() - (${placeholder} * INTERVAL '1 hour')`;
    case 'DAY':
      return `NOW() - (${placeholder} * INTERVAL '1 day')`;
    default:
      throw new Error(`Unsupported retention unit: ${unit}`);
  }
}

function buildDeleteConsumedDraftsSql(placeholder = '$1', unit = 'DAY') {
  const cutoffExpression = buildDeleteDraftCutoffExpression(placeholder, unit);
  return `
    DELETE FROM draft
    WHERE status = 'consumed'
      AND consumed_at IS NOT NULL
      AND consumed_at < ${cutoffExpression}
    RETURNING id;
  `;
}

function buildDeleteDiscardedDraftsSql(placeholder = '$1', unit = 'DAY') {
  const cutoffExpression = buildDeleteDraftCutoffExpression(placeholder, unit);
  return `
    DELETE FROM draft
    WHERE status = 'discarded'
      AND discarded_at IS NOT NULL
      AND discarded_at < ${cutoffExpression}
    RETURNING id;
  `;
}

function buildDeleteExpiredActiveDraftsSql(placeholder = '$1', unit = 'DAY') {
  const cutoffExpression = buildDeleteDraftCutoffExpression(placeholder, unit);
  return `
    DELETE FROM draft
    WHERE status = 'active'
      AND update_at < ${cutoffExpression}
    RETURNING id;
  `;
}

function buildDeleteExpiredDraftsSql() {
  const cutoffExpression = buildDeleteDraftCutoffExpression('$1', 'DAY');
  return `
    DELETE FROM draft
    WHERE (
      status = 'active' AND update_at < ${cutoffExpression}
    )
    OR (
      status = 'consumed'
      AND consumed_at IS NOT NULL
      AND consumed_at < ${cutoffExpression}
    )
    OR (
      status = 'discarded'
      AND discarded_at IS NOT NULL
      AND discarded_at < ${cutoffExpression}
    )
    RETURNING id;
  `;
}

module.exports = {
  buildUpsertDraftSql,
  buildFindDraftSql,
  buildFindDraftForConsumeSql,
  buildCheckOwnedArticleSql,
  buildValidateDraftFilesSql,
  buildClearRemovedDraftFilesSql,
  buildBindDraftFilesSql,
  buildDiscardDraftSql,
  buildConsumeDraftSql,
  buildDeleteConsumedDraftsSql,
  buildDeleteDiscardedDraftsSql,
  buildDeleteExpiredActiveDraftsSql,
  buildDeleteExpiredDraftsSql,
};
