const historyService = require('../service/history.service');
const Utils = require('../utils');
const Result = require('../app/Result');

class HistoryController {
  // 添加浏览记录
  async addHistory(ctx, next) {
    try {
      const { id: userId } = ctx.user;
      const { articleId } = ctx.request.body;

      const result = await historyService.addHistory(userId, articleId);
      ctx.body = result ? Result.success(result) : Result.fail('添加浏览记录失败');
    } catch (error) {
      console.log('addHistory error:', error);
      ctx.body = Result.fail('添加浏览记录失败');
    }
  }

  // 获取用户浏览历史
  getUserHistory = async (ctx, next) => {
    try {
      const { id: userId } = ctx.user;
      const { offset, limit } = ctx.query;
      console.log('addHistory this', this);
      const historyList = await historyService.getUserHistory(userId, offset, limit);
      const total = await historyService.getUserHistoryCount(userId);

      if (historyList) {
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
      } else {
        ctx.body = Result.fail('获取浏览历史失败');
      }
    } catch (error) {
      console.log('getUserHistory error:', error);
      ctx.body = Result.fail('获取浏览历史失败');
    }
  };

  // 删除单个浏览记录
  deleteHistory = async (ctx, next) => {
    try {
      const { id: userId } = ctx.user;
      const { articleId } = ctx.params;

      const result = await historyService.deleteHistory(userId, articleId);
      ctx.body = result.affectedRows > 0 ? Result.success(result) : Result.fail('删除浏览记录失败');
    } catch (error) {
      console.log('deleteHistory error:', error);
      ctx.body = Result.fail('删除浏览记录失败');
    }
  };

  // 清空用户浏览历史
  clearUserHistory = async (ctx, next) => {
    try {
      const { id: userId } = ctx.user;

      const result = await historyService.clearUserHistory(userId);
      ctx.body = Result.success(result);
    } catch (error) {
      console.log('clearUserHistory error:', error);
      ctx.body = Result.fail('清空浏览历史失败');
    }
  };

  // 检查是否已浏览过该文章
  hasViewed = async (ctx, next) => {
    try {
      const { id: userId } = ctx.user;
      const { articleId } = ctx.params;

      const hasViewed = await historyService.hasViewed(userId, articleId);
      ctx.body = Result.success({ hasViewed });
    } catch (error) {
      console.log('hasViewed error:', error);
      ctx.body = Result.fail('检查浏览记录失败');
    }
  };
}

module.exports = new HistoryController();
