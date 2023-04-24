const Router = require('koa-router');
const fileRouter = new Router({ prefix: '/upload' });
const { verifyAuth, verifyPermission } = require('../middleware/auth.middleware');
const { avatarHandler, pictureHandler, pictureResize } = require('../middleware/file.middleware');
const fileController = require('../controller/file.controller');
/* ★上传头像接口----------------------------------
1.除了要验证该人有无登陆外,还需有个中间件来保存我们的头像到服务器的某个位置
2.还需一个Controller来保存头像的信息*/
fileRouter.post('/avatar', verifyAuth, avatarHandler, fileController.saveAvatarInfo);

/* ★上传图片接口----------------------------------
若上传9张图片,则也得把这9张图片的信息保存起来*/
fileRouter.post('/picture', verifyAuth, pictureHandler, pictureResize, fileController.savePictureInfo);

fileRouter.post('/picture/:articleId', verifyAuth, fileController.updateFile);

module.exports = fileRouter;
