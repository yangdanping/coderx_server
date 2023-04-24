// 1.全局配置
const config = require('./config');
// 2.验证数据的第三方库
const validator = require('validator');
// 3.用于给service层使用的mysql2操作库
const connection = require('./database');
// 4.对body中的json数据进行解析的第三方库
const bodyParser = require('koa-bodyparser');
// 5.用于给app.on处理错误的中间件
const errorHandler = require('./error-handle');
// 6.用从工具类导出的路由加载器
const { useRoutes } = require('../utils');
module.exports = {
  config,
  validator,
  connection,
  bodyParser,
  errorHandler,
  useRoutes
};
