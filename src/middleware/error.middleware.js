/**
 * 全局异常捕获中间件
 *
 * 作用：
 * 1. 捕获所有 Controller/Service 层抛出的异常
 * 2. 区分 BusinessError（业务异常）和 Error（系统异常）
 * 3. 统一返回 Result.fail() 格式
 *
 * 使用后的收益：
 * - Controller 无需写 try-catch，只关心正常逻辑
 * - Service 无需吞掉异常，让错误自然冒泡
 * - 所有错误都有日志记录，便于排查
 *
 * 开发环境 vs 生产环境：
 * - 开发环境：返回详细错误信息，便于调试
 * - 生产环境：返回通用错误信息，避免泄露敏感信息
 */
const Result = require('@/app/Result');
const BusinessError = require('@/errors/BusinessError');
const { errorLogger } = require('@/app/logger');

// 判断是否为开发环境
const isDev = process.env.NODE_ENV !== 'production';

const errorMiddleware = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    // 1. 判断是业务异常还是系统异常
    const isBusinessError = error instanceof BusinessError;

    // 2. 确定 HTTP 状态码和错误信息
    const httpStatus = error.httpStatus || 500;
    const bizCode = error.bizCode || httpStatus;

    // 3. 根据环境决定返回的错误信息
    // - 业务异常：始终返回具体信息（如"文章不存在"）
    // - 系统异常：开发环境返回详细信息，生产环境返回通用信息
    let message;
    if (isBusinessError) {
      message = error.message;
    } else {
      message = isDev ? `[DEV] ${error.message}` : '服务器内部错误';
    }

    // 4. 记录错误日志（log4js）
    const logMessage = `[${isBusinessError ? 'BusinessError' : 'SystemError'}] ${error.message}\n路径: ${ctx.method} ${ctx.url}\nIP: ${ctx.ip}\n堆栈: ${error.stack}`;
    errorLogger.error(logMessage);

    // 5. 同时输出到 console（让 VS Code 调试控制台也能看到）
    console.error(`❌ [ErrorMiddleware] ${error.message}`);
    if (isDev) {
      console.error(error.stack);
    }

    // 6. 设置响应
    ctx.status = httpStatus;
    ctx.body = Result.fail(message, bizCode);
  }
};

module.exports = errorMiddleware;
