const Koa = require('koa');
const app = new Koa();
// const { config, bodyParser, useRoutes, errorHandler } = require('./app');
const { config, bodyParser, useRoutes, errorHandler, cleanOrphanFilesTask } = require('./app');
const loggerMiddleware = require('./middleware/logger.middleware');

app.on('error', errorHandler);

// 日志中间件要放在最前面，这样可以记录所有请求
app.use(loggerMiddleware);

app.use(bodyParser());
cleanOrphanFilesTask.start();
app.listen(config.APP_PORT, () => {
  useRoutes.call(app);
  console.log(`服务器在端口${config.APP_PORT}启动成功~`);
});
