export function buildAddAvatarSql() {
  return 'INSERT INTO avatar (user_id,filename, mimetype, size) VALUES (?,?,?,?) RETURNING id;';
}
