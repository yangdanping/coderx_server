import { NOTIFICATION_NEW_EVENT } from './notificationEvent.js';
import type { createNotificationEventBus } from './notificationEventBus.js';
import type { Close, PresenceSocket, SocketServer } from '../runtime/socket.types.js';

export function buildUserRoom(userId: string | number) {
  return `user:${userId}`;
}

export interface NotificationOptions {
  eventBus: Pick<ReturnType<typeof createNotificationEventBus>, 'subscribeNotificationEvents'>;
  closeEventBus?: Close;
  logger?: Pick<Console, 'log'>;
}

export default async function initializeSocketNotifications(
  io: SocketServer,
  { eventBus, closeEventBus, logger = console }: NotificationOptions,
) {
  const onConnection = (socket: PresenceSocket) => {
    const presenceAuth = socket.data.presenceAuth;
    if (presenceAuth?.mode === 'user') {
      return socket.join(buildUserRoom(presenceAuth.userId));
    }
  };

  const unsubscribe = await eventBus.subscribeNotificationEvents(({ notification }) => {
    const { recipientId } = notification;
    if (recipientId == null) return;
    // Each Socket server receives its own Redis subscription to this notification channel.
    io.local.to(buildUserRoom(recipientId)).emit(NOTIFICATION_NEW_EVENT, notification);
  });
  io.on('connection', onConnection);
  logger.log('✅ Socket.IO 通知服务已启动');

  return {
    async close() {
      io.off('connection', onConnection);
      await (closeEventBus ?? unsubscribe)();
    },
  };
}
