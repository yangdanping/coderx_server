const { redirectURL } = require('./urls');

const ALLOWED_ORIGINS = [
  'http://95.40.29.75:8080', // AWS 服务器 IP
  'https://coderx.my', // Vercel 生产环境 地址
  'https://api.ydp321.asia', // Cloudflare 代理域名
  redirectURL, // 环境变量配置的源
];

module.exports = {
  ALLOWED_ORIGINS,
};
