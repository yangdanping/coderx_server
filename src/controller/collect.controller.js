const collectService = require('@/service/collect.service.js');
const Result = require('@/app/Result');
const Utils = require('@/utils');

class collectController {
  addCollect = async (ctx, next) => {
    const userId = ctx.user.id;
    const { name } = ctx.request.body;
    const result = await collectService.addCollect(userId, name);
    ctx.body = Result.success(result);
  };

  getList = async (ctx, next) => {
    const { userId } = ctx.params;
    const { offset, limit } = Utils.getPaginationParams(ctx);
    const result = await collectService.getCollectList(userId, offset, limit);
    ctx.body = Result.success(result);
  };

  collectArticle = async (ctx, next) => {
    const { articleId } = ctx.request.body;
    const { collectId } = ctx.params;
    const isCollect = await collectService.hasCollect(articleId, Math.round(collectId));
    console.log(isCollect);

    const result = await collectService.changeCollect(articleId, isCollect ? collectId : Math.round(collectId), isCollect);

    ctx.body = Result.success(result, isCollect ? 1 : 0);
  };

  removeCollectArticle = async (ctx, next) => {
    const { idList } = ctx.query;
    const { collectId } = ctx.params;
    const userCollectedIds = JSON.parse(idList);
    console.log('userCollectedIds', userCollectedIds);

    await collectService.removeCollectArticle(userCollectedIds);
    const newCollectIds = await collectService.getCollectArticle(collectId);

    ctx.body = Result.success(newCollectIds);
  };
}

module.exports = new collectController();
