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
    LEFT JOIN flow_post_media fm ON fm.file_id = f.id
    WHERE f.user_id = ?
      ${SqlUtils.queryIn('f.id', mediaIds, 'AND')}
      AND f.file_type = 'image'
      AND f.article_id IS NULL
      AND f.draft_id IS NULL
      AND fm.file_id IS NULL
    ORDER BY f.id ASC
    FOR UPDATE OF f;
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
  buildFlowDetailSql,
  buildFlowFeedSql,
  buildInsertFlowMediaSql,
  buildInsertFlowSql,
  buildLockFlowMediaSql,
};
