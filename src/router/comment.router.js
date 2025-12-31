const Router = require('koa-router');
const commentRouter = new Router({ prefix: '/comment' });
const commentController = require('@/controller/comment.controller');
const { verifyAuth, verifyStatus, verifyPermission } = require('@/middleware/auth.middleware');

/**
 * 评论系统路由
 * 特点：
 * 1. 一级评论分页加载
 * 2. 子评论按需加载
 * 3. 游标分页（避免数据更新时的跳页问题）
 */

/* 获取一级评论列表（分页）
 * GET /comment?articleId=xxx&cursor=xxx&limit=5
 * 不需要登录即可查看 */
commentRouter.get('/', commentController.getCommentList);

/* 获取评论总数
 * GET /comment/count?articleId=xxx */
commentRouter.get('/count', commentController.getTotalCount);

/* 获取某条评论的回复列表（分页）
 * GET /comment/:commentId/replies?cursor=xxx&limit=10 */
commentRouter.get('/:commentId/replies', commentController.getReplies);

/* 获取单条评论
 * GET /comment/:commentId */
commentRouter.get('/:commentId', commentController.getCommentById);

/* 新增一级评论
 * POST /comment */
commentRouter.post('/', verifyAuth, verifyStatus, commentController.addComment);

/* 回复评论
 * POST /comment/:commentId/reply */
commentRouter.post('/:commentId/reply', verifyAuth, verifyStatus, commentController.addReply);

/* 点赞评论
 * POST /comment/:commentId/like */
commentRouter.post('/:commentId/like', verifyAuth, commentController.likeComment);

/* 修改评论
 * PUT /comment/:commentId */
commentRouter.put('/:commentId', verifyAuth, verifyPermission, commentController.updateComment);

/* 删除评论
 * DELETE /comment/:commentId */
commentRouter.delete('/:commentId', verifyAuth, verifyPermission, commentController.deleteComment);

module.exports = commentRouter;
