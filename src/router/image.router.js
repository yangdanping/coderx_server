const Router = require('koa-router');
const imageRouter = new Router({ prefix: '/img' });
const { verifyAuth } = require('../middleware/auth.middleware');
const { imgHandler, imgResize } = require('../middleware/file.middleware');
const imageController = require('../controller/image.controller');

/**
 * 图片上传路由模块
 * 处理图片的上传、删除、关联操作
 */

// ★上传图片接口
// POST /img
// 支持批量上传（最多9张）
imageRouter.post('/', verifyAuth, imgHandler, imgResize, imageController.saveImgInfo);

// ★关联图片到文章接口
// POST /img/:articleId
// 用于发布/编辑文章时，将上传的图片与文章关联，并设置封面
imageRouter.post('/:articleId', verifyAuth, imageController.updateFile);

// ★删除图片接口
// DELETE /img
imageRouter.delete('/', verifyAuth, imageController.deleteFile);

module.exports = imageRouter;
