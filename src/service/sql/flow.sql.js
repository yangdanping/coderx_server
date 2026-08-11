const SqlUtils = require('../../utils/SqlUtils');

function buildInsertFlowSql() {
  return `
    INSERT INTO flow_post (user_id, client_request_id, content, body_text)
    VALUES (?, ?, ?::jsonb, ?)
    ON CONFLICT (user_id, client_request_id) DO NOTHING RETURNING id;
  `;
}

function buildLockFlowMediaSql(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const mediaIds = Array.from({ length: count });
  return `
    SELECT f.id
    FROM file f
    WHERE ${SqlUtils.queryIn('f.id', mediaIds)}
    ORDER BY f.id ASC
    FOR UPDATE OF f;
  `;
}

function buildValidateFlowMediaSql(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const mediaIds = Array.from({ length: count });
  return `
    SELECT f.id, f.filename, f.mimetype, im.width, im.height
    FROM file f
    INNER JOIN image_meta im ON im.file_id = f.id
    WHERE f.user_id = ?
      AND (f.draft_id IS NULL OR f.draft_id = ?)
      ${SqlUtils.queryIn('f.id', mediaIds, 'AND')}
      AND f.file_type = 'image'
      AND f.mimetype = 'image/webp'
      AND f.filename ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$'
      AND im.width BETWEEN 1 AND 2560
      AND im.height BETWEEN 1 AND 2560
      AND f.article_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM flow_post_media fm
        WHERE fm.file_id = f.id
      )
    ORDER BY f.id ASC;
  `;
}

function buildLockActiveFlowDraftSql() {
  return `
    SELECT id
    FROM draft
    WHERE user_id = ?
      AND draft_type = 'flow'
      AND article_id IS NULL
      AND status = 'active'
    ORDER BY update_at DESC, id DESC
    LIMIT 1
    FOR UPDATE;
  `;
}

function buildClearFlowDraftMediaSql(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const mediaIds = Array.from({ length: count });
  return `
    UPDATE file
    SET draft_id = NULL
    WHERE draft_id = ?
      ${SqlUtils.queryIn('id', mediaIds, 'AND')};
  `;
}

function buildInsertFlowMediaSql(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const rows = Array.from({ length: count }, () => '(?, ?, ?)').join(', ');
  return `INSERT INTO flow_post_media (flow_id, file_id, position) VALUES ${rows};`;
}

function buildFindFlowByRequestIdSql() {
  return `
    SELECT id
    FROM flow_post
    WHERE user_id = ? AND client_request_id = ?
    LIMIT 1;
  `;
}

function flowMediaAggregateSql() {
  return `
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', f.id,
          'position', fm.position,
          'altText', fm.alt_text
        )
        ORDER BY fm.position ASC
      ) AS media
      FROM flow_post_media fm
      INNER JOIN file f ON f.id = fm.file_id
      WHERE fm.flow_id = fp.id
    ) media_agg ON TRUE
  `;
}

function buildFlowFeedSql() {
  return `
    SELECT
      fp.id,
      fp.content,
      fp.body_text AS "bodyText",
      fp.create_at AS "createAt",
      fp.update_at AS "updateAt",
      jsonb_build_object('id', u.id, 'name', u.name, 'nickname', p.nickname, 'avatarUrl', p.avatar_url) AS author,
      COALESCE(media_agg.media, '[]'::jsonb) AS media
    FROM flow_post fp
    INNER JOIN "user" u ON u.id = fp.user_id
    LEFT JOIN profile p ON p.user_id = u.id
    ${flowMediaAggregateSql()}
    ORDER BY fp.create_at DESC, fp.id DESC
    LIMIT ? OFFSET ?;
  `;
}

function buildFlowDetailSql() {
  return `
    SELECT
      fp.id,
      fp.content,
      fp.body_text AS "bodyText",
      fp.create_at AS "createAt",
      fp.update_at AS "updateAt",
      jsonb_build_object('id', u.id, 'name', u.name, 'nickname', p.nickname, 'avatarUrl', p.avatar_url) AS author,
      COALESCE(media_agg.media, '[]'::jsonb) AS media
    FROM flow_post fp
    INNER JOIN "user" u ON u.id = fp.user_id
    LEFT JOIN profile p ON p.user_id = u.id
    ${flowMediaAggregateSql()}
    WHERE fp.id = ?;
  `;
}

module.exports = {
  buildFindFlowByRequestIdSql,
  buildClearFlowDraftMediaSql,
  buildFlowDetailSql,
  buildFlowFeedSql,
  buildInsertFlowMediaSql,
  buildInsertFlowSql,
  buildLockActiveFlowDraftSql,
  buildLockFlowMediaSql,
  buildValidateFlowMediaSql,
};
