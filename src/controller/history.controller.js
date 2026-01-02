const historyService = require('@/service/history.service');
const Utils = require('@/utils');
const Result = require('@/app/Result');

class HistoryController {
  async addHistory(ctx, next) {
    const { id: userId } = ctx.user;
    const { articleId } = ctx.request.body;

    const result = await historyService.addHistory(userId, articleId);
    ctx.body = Result.success(result);
  }

  getUserHistory = async (ctx, next) => {
    const { id: userId } = ctx.user;
    const { offset, limit } = ctx.query;
    console.log('addHistory this', this);
    const historyList = await historyService.getUserHistory(userId, offset, limit);
    const total = await historyService.getUserHistoryCount(userId);

    // 处理每个浏览记录的内容显示
    historyList.forEach((item) => {
      if (!item.status) {
        // 清理HTML标签并截取内容长度
        item.content = Utils.removeHTMLTag(item.content);
        if (item.content.length > 50) {
          item.content = item.content.slice(0, 50);
        }
      } else {
        // 被封禁的文章显示提示信息
        item.title = item.content = '文章已被封禁';
      }
    });

    ctx.body = Result.success({
      result: historyList,
      total: total,
      pageNum: Math.floor(offset / limit) + 1,
      pageSize: parseInt(limit),
    });
  };

  deleteHistory = async (ctx, next) => {
    const { id: userId } = ctx.user;
    const { articleId } = ctx.params;

    const result = await historyService.deleteHistory(userId, articleId);
    ctx.body = Result.success(result);
  };

  clearUserHistory = async (ctx, next) => {
    const { id: userId } = ctx.user;

    const result = await historyService.clearUserHistory(userId);
    ctx.body = Result.success(result);
  };

  hasViewed = async (ctx, next) => {
    const { id: userId } = ctx.user;
    const { articleId } = ctx.params;

    const hasViewed = await historyService.hasViewed(userId, articleId);
    ctx.body = Result.success({ hasViewed });
  };
}

module.exports = new HistoryController();
