const { Pool } = require('pg');
const config = require('../config');
const { sqlLogger } = require('../logger');
const { buildPgPoolConfig } = require('./pg.config');
const { createPgConnectionAdapter } = require('./pg.utils');

const pool = new Pool(buildPgPoolConfig(config));

pool.on('error', (error) => {
  console.error('❌ PostgreSQL 连接池异常:', error.message);
});

const executeWithLogging = async (client, sql, params = []) => {
  const startTime = Date.now();

  try {
    sqlLogger.debug(`执行SQL: ${sql.trim()} | 参数: ${JSON.stringify(params)}`);
    const result = await client.execute(sql, params);
    const duration = Date.now() - startTime;
    sqlLogger.info(`✓ SQL执行成功 (${duration}ms)`);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    sqlLogger.error(`✗ SQL执行失败 (${duration}ms): ${error.message}`);
    throw error;
  }
};

const rootClient = {
  execute(sql, params = []) {
    return createPgConnectionAdapter(pool).execute(sql, params);
  },
  async getConnection() {
    const client = await pool.connect();
    return createPgConnectionAdapter(client);
  },
};

module.exports = {
  async execute(sql, params = []) {
    return executeWithLogging(rootClient, sql, params);
  },
  async getConnection() {
    const connection = await rootClient.getConnection();

    return {
      execute(sql, params = []) {
        return executeWithLogging(connection, sql, params);
      },
      beginTransaction: connection.beginTransaction,
      commit: connection.commit,
      rollback: connection.rollback,
      release: connection.release,
    };
  },
  async end() {
    await pool.end();
  },
};
