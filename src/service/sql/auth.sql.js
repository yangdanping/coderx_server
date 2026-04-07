function buildCheckStatusSql(dialect) {
  return dialect === 'pg' ? 'SELECT status FROM "user" WHERE id = ?;' : 'SELECT status FROM user WHERE id = ?;';
}

module.exports = {
  buildCheckStatusSql,
};
