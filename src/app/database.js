const mysql = require('mysql2');
const config = require('./config');

// 1.创建连接池--------------------
const connections = mysql.createPool({
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  database: config.MYSQL_DATABASE,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  connectionLimit: 10
});

// 2.使用连接池--------------------
connections.getConnection((err, con) => {
  con.connect((err) => (err ? console.log('数据库连接失败', err) : console.log(`${config.MYSQL_DATABASE}数据库连接成功!`)));
});

// 实战后面要操作数据库时,都是通过promise操作的,所以把promise进行导出
module.exports = connections.promise();
