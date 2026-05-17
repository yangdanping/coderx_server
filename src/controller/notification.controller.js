const Result = require('@/app/Result');
const Utils = require('@/utils');
const notificationService = require('@/service/notification.service');

class NotificationController {
  list = async (ctx) => {
    const { offset, limit } = Utils.getPaginationParams(ctx);
    const result = await notificationService.getNotificationList(ctx.user.id, { offset, limit });
    ctx.body = Result.success(result);
  };

  unreadCount = async (ctx) => {
    const count = await notificationService.getUnreadCount(ctx.user.id);
    ctx.body = Result.success({ count });
  };

  markRead = async (ctx) => {
    const result = await notificationService.markAsRead(ctx.params.notificationId, ctx.user.id);
    ctx.body = Result.success(result);
  };

  markAllRead = async (ctx) => {
    const result = await notificationService.markAllAsRead(ctx.user.id);
    ctx.body = Result.success(result);
  };
}

module.exports = new NotificationController();
