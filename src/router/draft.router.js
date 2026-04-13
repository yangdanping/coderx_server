const Router = require('@koa/router');
const draftRouter = new Router({ prefix: '/draft' });
const draftController = require('@/controller/draft.controller');
const { verifyAuth } = require('@/middleware/auth.middleware');

draftRouter.put('/', verifyAuth, draftController.saveDraft);
draftRouter.get('/', verifyAuth, draftController.getDraft);
draftRouter.get('/:articleId', verifyAuth, draftController.getDraftByArticleId);
draftRouter.delete('/:draftId', verifyAuth, draftController.deleteDraft);

module.exports = draftRouter;
