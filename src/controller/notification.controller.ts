import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { createNotificationService } from '../service/notification.factory.js';
import { pagination } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

type NotificationService = Pick<ReturnType<typeof createNotificationService>,
  'getNotificationList' | 'getUnreadCount' | 'markAsRead' | 'markAllAsRead'>;
const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: createReadHandlers } = createFactory<AppEnv, '/notification/:notificationId/read'>();

export function createNotificationController(service: NotificationService) {
  return {
    list: createHandlers(async c => {
      const page = pagination(new URL(c.req.url).searchParams);
      const result = await service.getNotificationList(authUserId(c.get('user')), page);
      return legacyJson(c, Result.success(result));
    }),

    unreadCount: createHandlers(async c => {
      const count = await service.getUnreadCount(authUserId(c.get('user')));
      return legacyJson(c, Result.success({ count }));
    }),

    markRead: createReadHandlers(async c => {
      const result = await service.markAsRead(c.req.param('notificationId'), authUserId(c.get('user')));
      return legacyJson(c, Result.success(result));
    }),

    markAllRead: createHandlers(async c => {
      const result = await service.markAllAsRead(authUserId(c.get('user')));
      return legacyJson(c, Result.success(result));
    }),
  };
}
