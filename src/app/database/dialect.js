const DIALECT_ALIASES = new Map([
  ['mysql', 'mysql'],
  ['mariadb', 'mysql'],
  ['pg', 'pg'],
  ['postgres', 'pg'],
  ['postgresql', 'pg'],
]);

const normalizeDialect = (dialect) => {
  if (!dialect) {
    return 'mysql';
  }

  const normalized = String(dialect).trim().toLowerCase();
  const resolvedDialect = DIALECT_ALIASES.get(normalized);

  if (!resolvedDialect) {
    throw new Error(`Unsupported DB_DIALECT: ${dialect}`);
  }

  return resolvedDialect;
};

const getClientModuleName = (dialect) => {
  return normalizeDialect(dialect) === 'pg' ? 'pg.client' : 'mysql.client';
};

module.exports = {
  getClientModuleName,
  normalizeDialect,
};
