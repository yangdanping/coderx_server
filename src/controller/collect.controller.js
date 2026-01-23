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
    const result = await collectService.toggleCollect(articleId, Math.round(collectId));
    ctx.body = Result.success(result);
  };

  removeCollectArticle = async (ctx, next) => {
    const { idList } = ctx.query;
    const { collectId } = ctx.params;
    const userCollectedIds = JSON.parse(idList);
    await collectService.removeCollectArticle(userCollectedIds);
    const newCollectIds = await collectService.getCollectArticle(collectId);

    ctx.body = Result.success(newCollectIds);
  };

  // 修改收藏夹名称
  updateCollect = async (ctx, next) => {
    const { collectId } = ctx.params;
    const { name } = ctx.request.body;
    const result = await collectService.updateCollect(collectId, name);
    ctx.body = Result.success(result);
  };

  // 删除收藏夹
  removeCollect = async (ctx, next) => {
    const { collectId } = ctx.params;
    const result = await collectService.removeCollect(collectId);
    ctx.body = Result.success(result);
  };
}

module.exports = new collectController();
