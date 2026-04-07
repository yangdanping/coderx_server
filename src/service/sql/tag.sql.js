function buildAddTagSql(dialect) {
  return dialect === 'pg' ? 'INSERT INTO tag (name) VALUES (?) RETURNING id;' : 'INSERT INTO tag (name) VALUES (?);';
}

function buildGetTagListSql(dialect) {
  return dialect === 'pg' ? 'SELECT * FROM tag LIMIT ? OFFSET ?;' : 'SELECT * FROM tag LIMIT ?,?;';
}

function buildGetTagListExecuteParams(dialect, offset, limit) {
  if (dialect === 'pg') {
    return [limit, offset];
  }

  return [offset, limit];
}

module.exports = {
  buildAddTagSql,
  buildGetTagListExecuteParams,
  buildGetTagListSql,
};
