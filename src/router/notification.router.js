const Router = require('@koa/router');
const notificationController = require('@/controller/notification.controller');
const { verifyAuth } = require('@/middleware/auth.middleware');

const notificationRouter = new Router({ prefix: '/notification' });

notificationRouter.get('/', verifyAuth, notificationController.list);
notificationRouter.get('/unread-count', verifyAuth, notificationController.unreadCount);
notificationRouter.patch('/read-all', verifyAuth, notificationController.markAllRead);
notificationRouter.patch('/:notificationId/read', verifyAuth, notificationController.markRead);

module.exports = notificationRouter;
