const Router = require('@koa/router');
const flowDraftRouter = new Router({ prefix: '/flow/draft' });
const flowDraftController = require('@/controller/flowDraft.controller');
const { verifyAuth } = require('@/middleware/auth.middleware');

flowDraftRouter.put('/', verifyAuth, flowDraftController.saveFlowDraft);
flowDraftRouter.get('/', verifyAuth, flowDraftController.getFlowDraft);
flowDraftRouter.delete('/:draftId', verifyAuth, flowDraftController.deleteFlowDraft);

module.exports = flowDraftRouter;
