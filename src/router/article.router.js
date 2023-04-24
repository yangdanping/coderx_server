const Router = require('koa-router');
const articleRouter = new Router({ prefix: '/article' });
const articleController = require('../controller/article.controller');
const { verifyAuth, verifyStatus, verifyPermission } = require('../middleware/auth.middleware');
const { verifytagExists } = require('../middleware/tag.middleware.js');

/* ★模糊查询接口---------------------------------- */
articleRouter.get('/search', articleController.search);

/* ★获取文章接口---------------------------------- */
articleRouter.get('/:articleId', articleController.getDetail);

/* ★获取文章列表接口---------------------------------- */
articleRouter.get('/', articleController.getList);

/* ★发布文章接口----------------------------------------------
用户发布文章必须先验证其是否登陆(授权) */
articleRouter.post('/', verifyAuth, verifyStatus, articleController.addArticle);

/* ★点赞文章接口---------------------------------- */
articleRouter.post('/:articleId/like', verifyAuth, verifyStatus, articleController.likeArticle);

/* ★改变标签接口---------------------------------- */
articleRouter.post('/:articleId/tag', verifyAuth, verifyPermission, verifytagExists, articleController.changeTag);

/* ★浏览文章接口---------------------------------- */
articleRouter.put('/:articleId/view', articleController.viewArticle);

/* ★修改文章接口---------------------------------- */
articleRouter.put('/:articleId', verifyAuth, verifyPermission, articleController.update);

/* ★删除文章接口---------------------------------- */
articleRouter.delete('/:articleId', verifyAuth, verifyPermission, articleController.delete);

/* ★<获取文字图片>的实现
到时前端是通过返回的数据进行对该接口的请求,<img :src="momentInfo.images">
注意,上传图像那边的接口增加中间件,增加不同尺寸的图片
到时起前端通过拼接上query参数来这里获取对应对应尺寸的图片*/
articleRouter.get('/images/:filename', articleController.getFileInfo);

module.exports = articleRouter;
