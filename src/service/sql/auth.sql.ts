export function buildCheckStatusSql() {
  return 'SELECT status FROM "user" WHERE id = ?;';
}
