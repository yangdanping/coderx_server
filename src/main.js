const Koa = require('koa');
const app = new Koa();
const { config, bodyParser, useRoutes, errorHandler } = require('./app');

app.on('error', errorHandler);
app.use(bodyParser());
app.listen(config.APP_PORT, () => {
  useRoutes.call(app);
  console.log(`服务器在端口${config.APP_PORT}启动成功~`);
});
