const Router = require('koa-router');
const userRouter = new Router({ prefix: '/user' });
const userController = require('../controller/user.controller');
const { verifyUserRegister, encryptUserPwd, verifyUserLogin } = require('../middleware/user.middleware');
const { verifyAuth } = require('../middleware/auth.middleware');
const Result = require('../app/Result');

/* ★检查授权用户接口------------------------------------------- */
userRouter.get('/checkAuth', verifyAuth, (ctx) => (ctx.body = Result.success()));

/* ★用户注册接口-------------------------------------------
大致流程:用户发过来账号(姓名/密码) --> 账号密码验证 --> 密码加密 --> 在数据库中存储起来 --> 注册成功  */
userRouter.post('/register', verifyUserRegister, encryptUserPwd, userController.addUser);

/* ★用户登陆接口-------------------------------------------
大致流程:用户发过来账号(姓名/密码) --> 账号密码验证 --> 进行用户授权 */
userRouter.post('/login', verifyUserLogin, userController.userLogin);

// 根据用户id查看回复反馈
userRouter.get('/feedback/:userId', verifyAuth, userController.getReplyByUserId);

/* ★获取用户文章接口------------------------------------------- */
userRouter.get('/:userId/article', userController.getArticle);

/* ★获取用户收藏夹文章接口------------------------------------------- */
userRouter.get('/:userId/collect', userController.getArticleByCollectId);

/* ★获取用户评论接口------------------------------------------- */
userRouter.get('/:userId/comment', userController.getComment);

/* ★获取用户基本信息接口------------------------------------------- */
userRouter.get('/:userId/profile', userController.getProfile);

/* ★修改用户基本信息接口------------------------------------------- */
userRouter.put('/profile', verifyAuth, userController.updateProfile);

/* ★获取用户点赞信息接口------------------------------------------- */
userRouter.get('/:userId/like', userController.getLiked);

/* ★获取头像接口------------------------------------------- */
userRouter.get('/:userId/avatar', userController.getAvatar);

/* ★关注用户接口------------------------------------------- */
userRouter.post('/:userId/follow', verifyAuth, userController.userFollow);

/* ★获取关注信息接口------------------------------------------- */
userRouter.get('/:userId/follow', userController.getFollow);

/* ★举报用户接口------------------------------------------- */
userRouter.post('/:userId/report', verifyAuth, userController.userReport);

/* ★用户反馈接口------------------------------------------- */
userRouter.post('/:userId/feedback', verifyAuth, userController.userFeedback);

module.exports = userRouter;
