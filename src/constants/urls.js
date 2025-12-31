// ❌ 循环依赖风险：引入 app 会导致 database.js 提前加载，此时环境变量可能还没就绪
// const { config } = require('@/app');
// ✅ 正确做法：只引入 config 模块，避免加载整个 app 实例导致循环依赖
const config = require('@/app/config');
const baseURL = `${config.APP_HOST}:${config.APP_PORT}`;
const redirectURL = `${config.APP_HOST}:${config.ASSETS_PORT}`;
const ollamaBaseURL = `${config.OLLAMA_HOST}:${config.OLLAMA_PORT}/v1`;

module.exports = {
  baseURL,
  redirectURL,
  ollamaBaseURL,
};
