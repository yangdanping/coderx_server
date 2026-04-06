const config = require('../config');
const { getClientModuleName, normalizeDialect } = require('./dialect');

const dialect = normalizeDialect(config.DB_DIALECT);
const client = require(`./${getClientModuleName(dialect)}`);

module.exports = Object.assign(client, {
  dialect,
  getClientModuleName,
  normalizeDialect,
});
