const Router = require('koa-router');
const aiController = require('@/controller/ai.controller');
const { verifyAuth } = require('@/middleware/auth.middleware'); // 引入鉴权中间件

const aiRouter = new Router({ prefix: '/ai' });

// 健康检查接口（无需登录，游客也可以访问）
aiRouter.get('/health', aiController.health);

// AI 聊天接口（无需登录，游客也可以使用）
// 如果你想限制为仅登录用户使用，添加 verifyAuth 中间件：
// aiRouter.post('/chat', verifyAuth, aiController.chat);
aiRouter.post('/chat', aiController.chat);

module.exports = aiRouter;
