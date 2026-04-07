const mysql = require('mysql2');
const config = require('../config');
const { sqlLogger } = require('../logger');

const connections = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_DATABASE,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  connectionLimit: 10,
});

connections.getConnection((err, con) => {
  if (err) {
    console.error('❌ 数据库连接池创建失败:', err.message);
    return;
  }

  con.connect((connectError) => {
    if (connectError) {
      console.error('❌ 数据库连接失败:', connectError.message);
    } else {
      console.log(`✅ ${config.DB_DATABASE} 数据库连接成功!`);
      con.release();
    }
  });
});

const promisePool = connections.promise();
const originalExecute = promisePool.execute.bind(promisePool);

promisePool.execute = async function (sql, params) {
  const startTime = Date.now();

  try {
    sqlLogger.debug(`执行SQL: ${sql.trim()} | 参数: ${JSON.stringify(params)}`);

    const result = await originalExecute(sql, params);
    const duration = Date.now() - startTime;
    sqlLogger.info(`✓ SQL执行成功 (${duration}ms)`);

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    sqlLogger.error(`✗ SQL执行失败 (${duration}ms): ${error.message}`);
    throw error;
  }
};

module.exports = promisePool;
