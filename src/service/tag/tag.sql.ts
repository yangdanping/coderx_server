export type TagPagination = string | string[];

export function buildAddTagSql() {
  return 'INSERT INTO tag (name) VALUES (?) RETURNING id;';
}

export function buildGetTagByNameSql() {
  return 'SELECT * FROM tag WHERE name = ?;';
}

export function buildGetTagListSql() {
  return 'SELECT * FROM tag ORDER BY id ASC LIMIT ? OFFSET ?;';
}

export function buildGetTagListExecuteParams(offset: TagPagination, limit: TagPagination) {
  return [limit, offset];
}

export function buildGetUserTagOrderSql() {
  return `
    SELECT t.id, t.name
    FROM tag t
    LEFT JOIN user_tag_preference utp
      ON utp.tag_id = t.id
     AND utp.user_id = ?
    ORDER BY
      utp.sort_order ASC NULLS LAST,
      CASE
        WHEN utp.sort_order IS NULL AND t.name = '人工智能' THEN 0
        ELSE 1
      END ASC,
      t.id ASC;
  `;
}

export function buildDeleteUserTagOrderSql() {
  return 'DELETE FROM user_tag_preference WHERE user_id = ?;';
}

export function buildInsertUserTagOrderSql(count: number) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const rows = Array.from({ length: count }, () => '(?, ?, ?)').join(', ');
  return `INSERT INTO user_tag_preference (user_id, tag_id, sort_order) VALUES ${rows};`;
}

export function buildGetExistingTagIdsSql(count: number) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const placeholders = Array.from({ length: count }, () => '?').join(', ');
  return `SELECT id FROM tag WHERE id IN (${placeholders});`;
}
