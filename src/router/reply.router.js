const Router = require('koa-router');
const replyRouter = new Router({ prefix: '/reply' });
const replyController = require('../controller/reply.controller');
const { verifyAuth, verifyStatus } = require('../middleware/auth.middleware');

/* ★<用户对评论的评论回复>的实现---------------------------------- */
replyRouter.post('/', verifyAuth, verifyStatus, replyController.addReply);

/* ★<用户对回复进行回复>的实现---------------------------------- */
replyRouter.post('/:replyId/reply', verifyAuth, verifyStatus, replyController.replyToReply);

/* ★<用户对回复点赞>的实现---------------------------------- */
replyRouter.post('/:replyId/like', verifyAuth, replyController.likeReply);

module.exports = replyRouter;

/*
首先,确定的是
文章 1 : n 评论
评论表为文章表的子表
评论 1 : n 回复
回复表为评论表的子表
*/
