const { NOTIFICATION_NEW_EVENT, subscribeNotificationEvents } = require('./notificationEventBus');

function buildUserRoom(userId) {
  return `user:${userId}`;
}

async function initializeSocketNotifications(io, options = {}) {
  const eventBus = options.eventBus || { subscribeNotificationEvents };
  const logger = options.logger || console;

  io.on('connection', (socket) => {
    const presenceAuth = socket.data?.presenceAuth;
    if (presenceAuth?.mode === 'user' && presenceAuth.userId != null) {
      socket.join(buildUserRoom(presenceAuth.userId));
    }
  });

  await eventBus.subscribeNotificationEvents(async ({ notification }) => {
    const recipientId = notification?.recipientId;
    if (recipientId == null) return;
    io.to(buildUserRoom(recipientId)).emit(NOTIFICATION_NEW_EVENT, notification);
  });

  logger.log('✅ Socket.IO 通知服务已启动');
}

module.exports = initializeSocketNotifications;
module.exports.buildUserRoom = buildUserRoom;
