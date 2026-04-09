const { Pool, types } = require('pg');
const config = require('../config');
const { sqlLogger } = require('../logger');
const { buildPgPoolConfig } = require('./pg.config');
const { createPgConnectionAdapter } = require('./pg.utils');

const INT8_OID = 20;

/**
 * node-postgres（pg）驱动会默认把 int8/bigint 解析成 string
 * 这是为了避免 64 位整数超出 JS Number 安全范围时发生静默精度丢失。
 *
 * 当前业务里的文章 id、浏览量、点赞数、COUNT(*) 等字段都依赖 number 语义，
 * 且现网数据量远小于 Number.MAX_SAFE_INTEGER，因此在数据库入口统一转为 number，
 * 可以避免前端再到处兼容 `'130'` / `130` 这种类型漂移。
 */
const parseSafeInt8 = (value) => {
  if (value == null) return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL int8 超出 JS 安全整数范围: ${value}`);
  }
  return parsed;
};

// 在连接池创建前注册全局类型解析器，使后续所有查询都共享同一套 bigint -> number 规则。
types.setTypeParser(INT8_OID, parseSafeInt8);

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
