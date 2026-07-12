function buildAddTagSql() {
  return 'INSERT INTO tag (name) VALUES (?) RETURNING id;';
}

function buildGetTagListSql() {
  return 'SELECT * FROM tag ORDER BY id ASC LIMIT ? OFFSET ?;';
}

function buildGetTagListExecuteParams(offset, limit) {
  return [limit, offset];
}

function buildGetUserTagOrderSql() {
  return `
    SELECT t.id, t.name
    FROM tag t
    LEFT JOIN user_tag_preference utp
      ON utp.tag_id = t.id
     AND utp.user_id = ?
    ORDER BY utp.sort_order ASC NULLS LAST, t.id ASC;
  `;
}

function buildDeleteUserTagOrderSql() {
  return 'DELETE FROM user_tag_preference WHERE user_id = ?;';
}

function buildInsertUserTagOrderSql(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const rows = Array.from({ length: count }, () => '(?, ?, ?)').join(', ');
  return `INSERT INTO user_tag_preference (user_id, tag_id, sort_order) VALUES ${rows};`;
}

function buildGetExistingTagIdsSql(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const placeholders = Array.from({ length: count }, () => '?').join(', ');
  return `SELECT id FROM tag WHERE id IN (${placeholders});`;
}

module.exports = {
  buildAddTagSql,
  buildDeleteUserTagOrderSql,
  buildGetExistingTagIdsSql,
  buildGetTagListExecuteParams,
  buildGetTagListSql,
  buildGetUserTagOrderSql,
  buildInsertUserTagOrderSql,
};
