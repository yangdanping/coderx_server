const mysql = require('mysql2');
const config = require('./config');
const { sqlLogger } = require('./logger');

// 1.创建连接池
const connections = mysql.createPool({
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  database: config.MYSQL_DATABASE,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  connectionLimit: 10
});

// 2.使用连接池
connections.getConnection((err, con) => {
  con.connect((err) => (err ? console.log('数据库连接失败', err) : console.log(`${config.MYSQL_DATABASE}数据库连接成功!`)));
});

// 3.通过promise方式操作数据库，并包装日志功能
const promisePool = connections.promise();

// 包装 execute 方法，添加 SQL 日志
const originalExecute = promisePool.execute.bind(promisePool);
promisePool.execute = async function (sql, params) {
  const startTime = Date.now();

  try {
    // 记录 SQL 执行前的日志
    sqlLogger.debug(`执行SQL: ${sql.trim()} | 参数: ${JSON.stringify(params)}`);

    const result = await originalExecute(sql, params);

    // 记录 SQL 执行成功
    const duration = Date.now() - startTime;
    sqlLogger.info(`✓ SQL执行成功 (${duration}ms)`);

    return result;
  } catch (error) {
    // 记录 SQL 执行失败
    const duration = Date.now() - startTime;
    sqlLogger.error(`✗ SQL执行失败 (${duration}ms): ${error.message}`);
    throw error;
  }
};

// 包装 query 方法（如果使用了 query）
const originalQuery = promisePool.query.bind(promisePool);
promisePool.query = async function (sql, params) {
  const startTime = Date.now();

  try {
    sqlLogger.debug(`执行Query: ${sql.trim()} | 参数: ${JSON.stringify(params)}`);
    const result = await originalQuery(sql, params);
    const duration = Date.now() - startTime;
    sqlLogger.info(`✓ Query执行成功 (${duration}ms)`);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    sqlLogger.error(`✗ Query执行失败 (${duration}ms): ${error.message}`);
    throw error;
  }
};

module.exports = promisePool;
