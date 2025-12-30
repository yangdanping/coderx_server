const Koa = require('koa');
const cors = require('@koa/cors');
const app = new Koa();
const { config, bodyParser, errorHandler } = require('./app');
const Utils = require('./utils');
const loggerMiddleware = require('./middleware/logger.middleware');
const aiService = require('./service/ai.service');
// 定时清理任务（单独导入，避免 socket_server.js 间接加载）
const cleanOrphanFilesTask = require('./tasks/cleanOrphanFiles');

// 错误中间件
app.on('error', errorHandler);

// CORS 中间件（必须在最前面，所有路由之前）
app.use(
  cors({
    origin: (ctx) => {
      // 允许的源列表
      const allowedOrigins = [
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://192.168.3.96:8080',
        'http://95.40.29.75:8080',
        'https://coderx.my', // Vercel 生产环境
        'https://coderx-ai.vercel.app', // Vercel 生产环境
        'https://api.ydp321.asia', // Cloudflare 代理域名
      ];
      const requestOrigin = ctx.headers.origin;
      if (allowedOrigins.includes(requestOrigin)) {
        return requestOrigin;
      }
      return allowedOrigins[0]; // 默认返回第一个
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
  }),
);

// 日志中间件要放在最前面，这样可以记录所有请求
app.use(loggerMiddleware);

app.use(bodyParser());
cleanOrphanFilesTask.start();
app.listen(config.APP_PORT, () => {
  Utils.useRoutes(app);
  console.log(`服务器在端口${config.APP_PORT}启动成功~`);
  // 启动时检查 AI 服务健康状态
  aiService.checkHealth();
});
