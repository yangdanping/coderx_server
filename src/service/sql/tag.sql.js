function buildAddTagSql() {
  return 'INSERT INTO tag (name) VALUES (?) RETURNING id;';
}

function buildGetTagListSql() {
  return 'SELECT * FROM tag LIMIT ? OFFSET ?;';
}

function buildGetTagListExecuteParams(offset, limit) {
  return [limit, offset];
}

module.exports = {
  buildAddTagSql,
  buildGetTagListExecuteParams,
  buildGetTagListSql,
};
