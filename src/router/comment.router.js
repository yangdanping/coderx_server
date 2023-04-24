const Router = require('koa-router');
const commentRouter = new Router({ prefix: '/comment' });
const commentController = require('../controller/comment.controller');
const { verifyAuth, verifyStatus, verifyPermission } = require('../middleware/auth.middleware');

/* ★<用户对文章评论>的实现---------------------------------- */
commentRouter.post('/', verifyAuth, verifyStatus, commentController.addComment);

/* ★<获取评论列表>的实现----------------------------------
设置为不登录的用户也能看评论列表 */
commentRouter.get('/', commentController.getList);

/* ★<用户对评论点赞>的实现---------------------------------- */
commentRouter.post('/:commentId/like', verifyAuth, commentController.likeComment);

/* ★<用户对评论回复>的实现----------------------------------
一开始是把commentId放到body中传过来的,但不符合Restful风格
由于是对某一条评论的回复,所以当我对某条具体评论做操作时,最好也把commentId放上去,
相当于回复id为1的评论对应的url --> {{baseUrl}}comment/1/reply,到时前端也要这样拼接id
在Controller里就在body.params中取这个commentId,这样更加符合Restful风格*/
commentRouter.post('/:commentId/reply', verifyAuth, verifyStatus, commentController.reply);

/* ★<用户修改评论>的实现----------------------------------
除了要验证授权,你只能修改你之前发表的评论,所以得加一个验证权限中间件(先把update逻辑走通再加)
注意!我们之前验证的是修改动态的人有无权限(authService.checkMoment),你这次修改的是评论,
所以你要验证你修改评论的人有无权限 */
commentRouter.put('/:commentId', verifyAuth, verifyPermission, commentController.update);

/* ★<用户删除评论>的实现---------------------------------- */
commentRouter.delete('/:commentId', verifyAuth, verifyPermission, commentController.delete);

module.exports = commentRouter;
