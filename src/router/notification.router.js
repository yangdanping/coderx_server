const Router = require('@koa/router');
const notificationController = require('@/controller/notification.controller');
const { verifyAuth } = require('@/middleware/auth.middleware');

const notificationRouter = new Router({ prefix: '/notification' });

// 文章删除后的清理有意由 notifications 表的外键约束负责，而非由下面这些读/更新路由处理：
// - notifications.article_id -> article(id) ON DELETE CASCADE 会删除与文章相关的通知。
// - notifications.comment_id -> comment(id) ON DELETE SET NULL 在仅删除评论时会保留评论快照。
// 若产品日后希望在文章被删除后仍保留相关通知，应先修改数据库约束，
// 并在依赖路由/控制器行为之前，增加明确的「目标已无效」交互体验。
notificationRouter.get('/', verifyAuth, notificationController.list);
notificationRouter.get('/unread-count', verifyAuth, notificationController.unreadCount);
notificationRouter.patch('/read-all', verifyAuth, notificationController.markAllRead);
notificationRouter.patch('/:notificationId/read', verifyAuth, notificationController.markRead);

module.exports = notificationRouter;
