const { requestLogger } = require('@/app/logger');

const loggerMiddleware = async (ctx, next) => {
  const startTime = Date.now();

  // 记录请求信息
  requestLogger.info(`→ ${ctx.method} ${ctx.url} | IP: ${ctx.ip}`);

  // 记录请求体（仅对 POST/PUT/PATCH 等方法）
  if (['POST', 'PUT', 'PATCH'].includes(ctx.method) && ctx.request.body) {
    // 过滤敏感信息（如密码）
    const safeBody = { ...ctx.request.body };
    if (safeBody.password) {
      safeBody.password = '******';
    }
    requestLogger.debug(`  请求体: ${JSON.stringify(safeBody)}`);
  }

  try {
    await next(); // 执行后续中间件和路由

    // 记录响应信息
    const duration = Date.now() - startTime;
    const statusColor = ctx.status >= 400 ? '✗' : '✓';
    requestLogger.info(`${statusColor} ${ctx.method} ${ctx.url} | Status: ${ctx.status} | ${duration}ms`);

    // 如果响应状态码 >= 400，记录响应体
    if (ctx.status >= 400) {
      requestLogger.warn(`  响应体: ${JSON.stringify(ctx.body)}`);
    }
  } catch (error) {
    // 记录错误（错误会被全局错误处理器捕获）
    const duration = Date.now() - startTime;
    requestLogger.error(`✗ ${ctx.method} ${ctx.url} | Error: ${error.message} | ${duration}ms`);
    throw error; // 继续抛出，让错误处理器处理
  }
};

module.exports = loggerMiddleware;
