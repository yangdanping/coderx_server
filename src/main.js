const Koa = require('koa');
require('module-alias/register'); // 注册路径别名 @ -> src
const cors = require('@koa/cors');
const app = new Koa();
const { config, bodyParser, errorHandler } = require('@/app');
const Utils = require('@/utils');
const loggerMiddleware = require('@/middleware/logger.middleware');
const errorMiddleware = require('@/middleware/error.middleware'); // 全局异常捕获中间件
const aiService = require('@/service/ai.service');
const { ALLOWED_ORIGINS } = require('@/constants/cors');
// 定时清理任务（单独导入，避免 socket_server.js 间接加载）
const cleanOrphanFilesTask = require('@/tasks/cleanOrphanFiles');

// 错误处理中间件（用于处理 ctx.app.emit('error') 触发的错误，如认证失败）
app.on('error', errorHandler);

// 🚀 全局异常捕获中间件（必须是第一个中间件，用于捕获所有 async 函数中的异常）
app.use(errorMiddleware);

// CORS 中间件（必须在最前面，所有路由之前）
app.use(
  cors({
    origin: (ctx) => {
      // 允许的源列表
      const requestOrigin = ctx.headers.origin;
      if (ALLOWED_ORIGINS.includes(requestOrigin)) {
        return requestOrigin;
      }
      return ALLOWED_ORIGINS[0]; // 默认返回第一个
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
