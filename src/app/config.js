const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
dotenv.config(); // 调用dotenv的config,.env文件中的所有值就被放入到process.env中了

const PRIVATE_KEY = fs.readFileSync(path.resolve(__dirname, './keys/private.key'));
const PUBLIC_KEY = fs.readFileSync(path.resolve(__dirname, './keys/public.key'));
module.exports = {
  APP_HOST,
  APP_PORT,
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_DATABASE,
  MYSQL_USER,
  MYSQL_PASSWORD } = process.env;// 在process.env中取出APP_PORT放到该对象中并将该对象导出

module.exports.PRIVATE_KEY = PRIVATE_KEY;
module.exports.PUBLIC_KEY = PUBLIC_KEY;

