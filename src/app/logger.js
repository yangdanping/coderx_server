const log4js = require('log4js');
const path = require('path');

// 配置 log4js
log4js.configure({
  appenders: {
    // SQL 日志 - 按日期分割
    sql: {
      type: 'dateFile',
      filename: path.resolve(__dirname, '../../logs', 'sql', 'logging.log'),
      maxLogSize: 1024 * 1024, // 1MB
      keepFileExt: true,
      layout: {
        type: 'pattern',
        pattern: '[%d{yyyy-MM-dd hh:mm:ss}] [%p] %m%n',
      },
    },
    // 请求日志
    request: {
      type: 'dateFile',
      filename: path.resolve(__dirname, '../../logs', 'request', 'logging.log'),
      maxLogSize: 1024 * 1024,
      keepFileExt: true,
      layout: {
        type: 'pattern',
        pattern: '[%d{yyyy-MM-dd hh:mm:ss}] [%p] %m%n',
      },
    },
    // 错误日志
    error: {
      type: 'dateFile',
      filename: path.resolve(__dirname, '../../logs', 'error', 'logging.log'),
      maxLogSize: 1024 * 1024,
      keepFileExt: true,
      layout: {
        type: 'pattern',
        pattern: '[%d{yyyy-MM-dd hh:mm:ss}] [%p] %m%n',
      },
    },
    // 控制台输出
    console: {
      type: 'stdout',
    },
  },
  categories: {
    sql: {
      appenders: ['sql', 'console'], // 同时输出到文件和控制台
      level: 'debug',
    },
    request: {
      appenders: ['request', 'console'],
      level: 'info',
    },
    error: {
      appenders: ['error', 'console'],
      level: 'error',
    },
    default: {
      appenders: ['console'],
      level: 'info',
    },
  },
});

// 程序退出时确保日志记录完整
process.on('exit', () => {
  log4js.shutdown();
});

module.exports = {
  sqlLogger: log4js.getLogger('sql'),
  requestLogger: log4js.getLogger('request'),
  errorLogger: log4js.getLogger('error'),
  logger: log4js.getLogger(),
};
