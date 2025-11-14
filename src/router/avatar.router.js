const Router = require('koa-router');
const avatarRouter = new Router({ prefix: '/avatar' });
const { verifyAuth } = require('../middleware/auth.middleware');
const { avatarHandler } = require('../middleware/file.middleware');
const avatarController = require('../controller/avatar.controller');

/**
 * 头像上传路由模块
 * 职责：处理头像的上传、删除操作
 * 注：图片路由在 image.router.js，视频路由在 video.router.js
 */

// ★上传头像接口
// POST /avatar
// 1. 验证用户登录
// 2. 处理头像文件上传
// 3. 保存头像信息到数据库
avatarRouter.post('/', verifyAuth, avatarHandler, avatarController.saveAvatarInfo);

// ★删除头像接口
// DELETE /avatar/:userId
avatarRouter.delete('/:userId', verifyAuth, avatarController.deleteAvatar);

module.exports = avatarRouter;
