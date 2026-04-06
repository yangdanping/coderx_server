function buildAddAvatarSql(dialect) {
  const returning = dialect === 'pg' ? ' RETURNING id;' : '';
  return `INSERT INTO avatar (user_id,filename, mimetype, size) VALUES (?,?,?,?)${returning}`;
}

module.exports = {
  buildAddAvatarSql,
};
