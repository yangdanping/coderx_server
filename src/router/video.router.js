const Router = require('koa-router');
const videoRouter = new Router({ prefix: '/video' });
const { verifyAuth } = require('@/middleware/auth.middleware');
const { videoHandler } = require('@/middleware/file.middleware');
const videoController = require('@/controller/video.controller');

/**
 * 视频路由模块
 * 处理视频上传、删除、关联等操作
 */

// ★上传视频接口
// POST /video
// 中间件：验证登录 -> 处理视频文件上传 -> 保存视频信息
videoRouter.post('/', verifyAuth, videoHandler, videoController.saveVideoInfo);

// ★关联视频到文章接口
// POST /video/:articleId
// 用于发布/编辑文章时，将上传的视频与文章关联
videoRouter.post('/:articleId', verifyAuth, videoController.updateVideoArticle);

// ★删除视频接口
// DELETE /video
// 删除视频文件及其数据库记录（包括封面图）
videoRouter.delete('/', verifyAuth, videoController.deleteVideo);

// ★获取视频信息接口（可选，用于调试或前端需要）
// GET /video/:videoId
videoRouter.get('/:videoId', videoController.getVideoInfo);

module.exports = videoRouter;
