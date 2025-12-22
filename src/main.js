const Koa = require('koa');
const app = new Koa();
const { config, bodyParser, errorHandler } = require('./app');
const Utils = require('./utils');
const loggerMiddleware = require('./middleware/logger.middleware');
const aiService = require('./service/ai.service');
// 定时清理任务（单独导入，避免 socket_server.js 间接加载）
const cleanOrphanFilesTask = require('./tasks/cleanOrphanFiles');

// 错误中间件
app.on('error', errorHandler);

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
