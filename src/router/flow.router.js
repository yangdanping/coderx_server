const Router = require('@koa/router');
const flowController = require('@/controller/flow.controller');
const { verifyAuth } = require('@/middleware/auth.middleware');
const mediaMutationMaintenance = require('@/middleware/mediaMaintenance.middleware');

const flowRouter = new Router();

flowRouter.post('/flow', mediaMutationMaintenance, verifyAuth, flowController.createFlow);
flowRouter.get('/flow', flowController.getFlowFeed);
flowRouter.get(/^\/flow\/([1-9]\d*)$/, async (ctx, next) => {
  ctx.params = { ...ctx.params, flowId: ctx.captures[0] };
  return flowController.getFlowDetail(ctx, next);
});

module.exports = flowRouter;
