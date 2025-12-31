// 1.全局配置
const config = require('./config');
// 2.验证数据的第三方库
const validator = require('validator');

// 3.用于给service层使用的mysql2操作库
/*
❌ 避免在入口文件中加载重量级模块，应在 service 层按需加载
require() 的机制是：首次加载模块时，会运行模块内的所有代码（包括变量声明、函数定义等），然后缓存模块的 exports 对象
后续再次 require() 同一个模块时，不会重新执行代码，而是直接返回缓存的结果
const connection = require('./database');
*/

// 4.对body中的json数据进行解析的第三方库
const bodyParser = require('koa-bodyparser');
// 5.用于给app.on处理错误的中间件
const errorHandler = require('./errorHandler');
// 6.用从工具类导出的路由加载器
const Utils = require('@/utils');

// 注意：cleanOrphanFilesTask 不在这里导出，避免 socket_server.js 间接加载
// 请在 main.js 中单独 require('@/tasks/cleanOrphanFiles')

module.exports = {
  config,
  validator,
  // connection, // 移除 connection 导出
  bodyParser,
  errorHandler,
  useRoutes: Utils.useRoutes,
};
