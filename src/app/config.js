const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// 根据 NODE_ENV 环境变量，动态选择加载 .env.production 或 .env.development 配置文件
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

console.log(`正在加载环境变量: ${envFile}`);

const PRIVATE_KEY = fs.readFileSync(path.resolve(__dirname, './keys/private.key'));
const PUBLIC_KEY = fs.readFileSync(path.resolve(__dirname, './keys/public.key'));
module.exports = {
  APP_HOST,
  APP_PORT,
  DB_DIALECT,
  DATABASE_URL,
  DB_HOST,
  DB_PORT,
  DB_DATABASE,
  DB_USER,
  DB_PASSWORD,
  PGHOST,
  PGPORT,
  PGDATABASE,
  PGUSER,
  PGPASSWORD,
  OLLAMA_HOST,
  OLLAMA_PORT,
  ASSETS_PORT,
} = process.env; // 在process.env中取出配置项并将该对象导出

module.exports.PRIVATE_KEY = PRIVATE_KEY;
module.exports.PUBLIC_KEY = PUBLIC_KEY;
