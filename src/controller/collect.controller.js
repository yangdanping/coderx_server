const collectService = require('../service/collect.service.js');
const userService = require('../service/user.service.js');
const Result = require('../app/Result');

class collectController {
  async addCollect(ctx, next) {
    const userId = ctx.user.id;
    const { name } = ctx.request.body;
    const result = await collectService.addCollect(userId, name);
    ctx.body = result ? Result.success(result) : Result.fail('增加收藏夹失败!');
  }
  async getList(ctx, next) {
    const { userId } = ctx.params;
    const { offset, limit } = ctx.query;
    const result = await collectService.getCollectList(userId, offset, limit);
    ctx.body = result ? Result.success(result) : Result.fail('获取收藏夹列表失败!');
  }
  async collectArticle(ctx, next) {
    const { articleId } = ctx.request.body;
    const { collectId } = ctx.params;
    const isCollect = await collectService.hasCollect(articleId, Math.round(collectId));
    console.log(isCollect);
    if (!isCollect) {
      const result = await collectService.changeCollect(articleId, Math.round(collectId), isCollect);
      ctx.body = Result.success(result); //增加一条收藏记录
    } else {
      const result = await collectService.changeCollect(articleId, collectId, isCollect);
      ctx.body = Result.success(result, 1); //减少一条收藏记录
    }
  }
  async removeCollectArticle(ctx, next) {
    const { idList } = ctx.query;
    const { collectId } = ctx.params;
    const userCollectedIds = JSON.parse(idList);
    console.log('userCollectedIds', userCollectedIds);
    const result = await collectService.removeCollectArticle(userCollectedIds);
    if (result) {
      const newCollectIds = await collectService.getCollectArticle(collectId);
      ctx.body = newCollectIds ? Result.success(newCollectIds) : Result.fail('移除失败!'); //返回移除后的文章
    }
  }
}

module.exports = new collectController();
