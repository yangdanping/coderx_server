export const NOTIFICATION_NEW_EVENT = 'notification:new';

export type NotificationPayload = object & { recipientId?: string | number | null };

export interface NotificationEvent {
  event: typeof NOTIFICATION_NEW_EVENT;
  notification: NotificationPayload;
}

export function buildNotificationChannel(keyPrefix = process.env.REDIS_KEY_PREFIX || 'coderx') {
  return `${keyPrefix}:notification:new`;
}

export function encodeNotificationCreated(notification: unknown) {
  return JSON.stringify({ event: NOTIFICATION_NEW_EVENT, notification });
}

export function decodeNotificationEvent(message: string): NotificationEvent | undefined {
  const payload: unknown = JSON.parse(message);
  if (typeof payload !== 'object' || payload === null || !('event' in payload) ||
    payload.event !== NOTIFICATION_NEW_EVENT || !('notification' in payload)) return;

  const { notification } = payload;
  if (typeof notification !== 'object' || notification === null) return;
  if ('recipientId' in notification && notification.recipientId != null &&
    typeof notification.recipientId !== 'string' && typeof notification.recipientId !== 'number') return;
  return { event: NOTIFICATION_NEW_EVENT, notification };
}
