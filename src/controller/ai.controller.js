const aiService = require('@/service/ai.service');
const { errorLogger } = require('@/app/logger');

class AiController {
  /**
   * 健康检查接口(
   * 用于前端检测 AI 服务是否可用
   */
  health = async (ctx, next) => {
    try {
      const [isHealthy, models] = await aiService.checkHealth();
      ctx.status = 200;
      ctx.body = {
        models,
        status: isHealthy ? 'online' : 'offline',
        message: isHealthy ? 'AI service is running' : 'AI service is not available',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      ctx.status = 503;
      ctx.body = {
        models: [],
        status: 'offline',
        message: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  };

  chat = async (ctx, next) => {
    // 从请求体中获取消息历史和上下文
    const { messages, model, context } = ctx.request.body;
    if (!messages || !Array.isArray(messages)) {
      ctx.status = 400;
      ctx.body = { message: 'Invalid messages format' };
      return;
    }

    try {
      // 🧪 测试开关：取消注释下面一行来触发错误，验证 errorLogger 是否正常记录日志
      // throw new Error('测试错误：模拟 AI 服务连接失败');

      // 获取 AI SDK 的 result 对象
      const result = await aiService.streamChat(messages, model, context);

      // 使用 toUIMessageStreamResponse 将结果转换为带有 UI 消息流的流式响应对象。
      const res = await result.toUIMessageStreamResponse();

      // 禁用 Koa 的自动响应处理
      ctx.respond = false;

      // 设置响应头
      ctx.status = res.status;
      for (const [key, value] of res.headers.entries()) {
        ctx.res.setHeader(key, value);
      }

      // 手动 pipe 流到 res
      const reader = res.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          console.log('🔥 [AI Controller] value:', JSON.stringify(value));
          ctx.res.write(value);
        }
        ctx.res.end();
      } catch (streamError) {
        console.error('Stream reading error:', streamError);
        ctx.res.end();
      }
    } catch (error) {
      // 🆕 手动记录错误日志
      // 原因：流式响应需要在 try-catch 中捕获错误（无法抛给全局中间件）
      // 如果不手动调用 errorLogger，错误将不会被记录到日志文件
      // 其他模块的错误会自然抛出 → 由全局中间件统一记录
      const logMessage = `[AI Controller Error] ${error.message}\n路径: ${ctx.method} ${ctx.url}\nIP: ${ctx.ip}\n堆栈: ${error.stack}`;
      errorLogger.error(logMessage);
      console.error('❌ [AI Controller Error]', error.message);

      // 如果还没有发送响应头，可以返回 JSON 错误
      if (!ctx.headerSent) {
        ctx.status = 503; // Service Unavailable
        ctx.body = {
          success: false,
          message: error.message,
          code: error.code || 'AI_SERVICE_ERROR',
          timestamp: new Date().toISOString(),
        };
      } else {
        // 如果已经开始流式传输，尝试结束响应
        try {
          ctx.res.end();
        } catch (e) {
          console.error('Error ending res:', e);
        }
      }
    }
  };
  /**
   * 编辑补全接口
   * 用于编辑器内联补全功能，非流式快速响应
   */
  completion = async (ctx, next) => {
    const { beforeText, afterText, model, maxSuggestions } = ctx.request.body;

    // 参数验证
    if (!beforeText || typeof beforeText !== 'string') {
      ctx.status = 400;
      ctx.body = {
        success: false,
        message: 'beforeText is required and must be a string',
      };
      return;
    }

    // 上下文长度限制（熔断机制）
    const MAX_BEFORE = 500;
    const MAX_AFTER = 200;
    const truncatedBefore = beforeText.slice(-MAX_BEFORE);
    const truncatedAfter = afterText ? afterText.slice(0, MAX_AFTER) : '';

    try {
      const suggestions = await aiService.getCompletion(truncatedBefore, truncatedAfter, model, maxSuggestions || 3);

      ctx.status = 200;
      ctx.body = {
        success: true,
        suggestions,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('❌ [AI Completion Controller Error]', error.message);

      ctx.status = 503;
      ctx.body = {
        success: false,
        message: error.message,
        code: error.code || 'COMPLETION_ERROR',
        suggestions: [],
        timestamp: new Date().toISOString(),
      };
    }
  };
}

module.exports = new AiController();
