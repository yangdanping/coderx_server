const Router = require('koa-router');
const tagRouter = new Router({ prefix: '/tag' });
const tagController = require('../controller/tag.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
// const { verifyUserRegister, encryptUserPwd, verifyUserLogin } = require('../tag/user.middleware');

/* ★<用户创建标签>的实现----------------------------------
当然用户是要登陆才能创建一个新的东西,所以要验证 --> verifyAuth
标签与动态之间应属于多对多的关系,因为一个标签可以属于很多个动态,
而一个动态可以拥有多个标签,所以中间应建一个关系表 --> tag_label表 */
tagRouter.post('/', verifyAuth, tagController.addTag);

/* ★<用户展示标签>的实现----------------------------------
当然用户是要登陆才能创建一个新的东西,所以要验证 --> verifyAuth */
tagRouter.get('/', tagController.getList);

module.exports = tagRouter;
