const { Pool, types } = require('pg');
const { buildPgPoolConfig } = require('@/app/database/pg.config');
const { createPgConnectionAdapter } = require('@/app/database/pg.utils');

const INT8_OID = 20;

types.setTypeParser(INT8_OID, (value) => {
  if (value == null) return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL int8 exceeds the JavaScript safe integer range: ${value}`);
  }
  return parsed;
});

function createIngestDatabase(config) {
  const pool = new Pool(buildPgPoolConfig(config));

  return {
    execute(sql, params = []) {
      return createPgConnectionAdapter(pool).execute(sql, params);
    },
    async getConnection() {
      const client = await pool.connect();
      return createPgConnectionAdapter(client);
    },
    async end() {
      await pool.end();
    },
  };
}

module.exports = {
  createIngestDatabase,
};
