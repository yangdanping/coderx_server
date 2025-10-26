const Router = require('koa-router');
const historyRouter = new Router({ prefix: '/history' });
const historyController = require('../controller/history.controller');
const { verifyAuth } = require('../middleware/auth.middleware');

/* ★添加浏览记录接口 */
historyRouter.post('/', verifyAuth, historyController.addHistory);

/* ★获取用户浏览历史接口 */
historyRouter.get('/', verifyAuth, historyController.getUserHistory);

/* ★删除单个浏览记录接口 */
historyRouter.delete('/:articleId', verifyAuth, historyController.deleteHistory);

/* ★清空用户浏览历史接口 */
historyRouter.delete('/', verifyAuth, historyController.clearUserHistory);

/* ★检查是否已浏览过该文章接口 */
historyRouter.get('/:articleId/check', verifyAuth, historyController.hasViewed);

module.exports = historyRouter;
