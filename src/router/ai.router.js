const Router = require('@koa/router');
const aiController = require('@/controller/ai.controller');
const { verifyAuth } = require('@/middleware/auth.middleware');
const { chatRateLimit, completionRateLimit } = require('@/middleware/ai.middleware');

const aiRouter = new Router({ prefix: '/ai' });

// 健康检查接口（无需登录，游客也可以访问）
aiRouter.get('/health', aiController.health);

// AI 聊天接口：保留游客可用，新增后端限流中间件
aiRouter.post('/chat', chatRateLimit, aiController.chat);

// AI 编辑补全接口：仅允许登录用户使用，避免意外登录的游客滥用高频补全。
aiRouter.post('/completion', verifyAuth, completionRateLimit, aiController.completion);

module.exports = aiRouter;
