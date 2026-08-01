const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// 根据 NODE_ENV 环境变量，动态选择加载 .env.production 或 .env.development 配置文件
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({
  path: path.resolve(process.cwd(), envFile),
  quiet: process.env.CONFIG_QUIET === 'true',
});

if (process.env.CONFIG_QUIET !== 'true') console.log(`正在加载环境变量: ${envFile}`);

const PRIVATE_KEY = fs.readFileSync(path.resolve(__dirname, './keys/private.key'));
const PUBLIC_KEY = fs.readFileSync(path.resolve(__dirname, './keys/public.key'));
const configKeys = [
  'APP_HOST',
  'APP_PORT',
  'DATABASE_URL',
  'PUBLIC_API_ORIGIN',
  'FRONTEND_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'OLLAMA_HOST',
  'OLLAMA_PORT',
  'ASSETS_PORT',
];

module.exports = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]));

module.exports.MEDIA_WRITE_MODE = process.env.MEDIA_WRITE_MODE || 'local';
module.exports.MEDIA_READ_MODE = process.env.MEDIA_READ_MODE || 'local';
module.exports.MEDIA_KEEP_LOCAL_AFTER_PROMOTE = process.env.MEDIA_KEEP_LOCAL_AFTER_PROMOTE || 'true';
module.exports.MEDIA_R2_WRITE_PAUSED = process.env.MEDIA_R2_WRITE_PAUSED || 'false';
module.exports.MEDIA_MUTATIONS_PAUSED = process.env.MEDIA_MUTATIONS_PAUSED || 'false';
module.exports.MEDIA_CDN_BASE_URL = process.env.MEDIA_CDN_BASE_URL || 'https://media.ydp321.asia';
module.exports.R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
module.exports.R2_BUCKET = process.env.R2_BUCKET || 'coderx-media-public';
module.exports.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
module.exports.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
module.exports.R2_HARD_LIMIT_BYTES = process.env.R2_HARD_LIMIT_BYTES || '7000000000';
module.exports.R2_RESUME_LIMIT_BYTES = process.env.R2_RESUME_LIMIT_BYTES || '6000000000';

module.exports.PRIVATE_KEY = PRIVATE_KEY;
module.exports.PUBLIC_KEY = PUBLIC_KEY;
