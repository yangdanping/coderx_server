const aiService = require('../service/ai.service');

class AiController {
  /**
   * 健康检查接口
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
}

module.exports = new AiController();
