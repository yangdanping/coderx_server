import { createPresenceRedisClient, destroyRedisConnection, type RedisClientFactory, type RedisConnection } from '../redis/redisClient.js';
import {
  buildNotificationChannel,
  decodeNotificationEvent,
  encodeNotificationCreated,
  type NotificationEvent,
} from './notificationEvent.js';

export { NOTIFICATION_NEW_EVENT, buildNotificationChannel } from './notificationEvent.js';

type MessageListener = (message: string, channel: string) => void | Promise<void>;
type Publisher = { publish(channel: string, payload: string): Promise<number> };
type Subscriber = {
  subscribe(channel: string, listener: MessageListener): Promise<unknown>;
  unsubscribe(channel: string, listener: MessageListener): Promise<unknown>;
};

type EventHandler = (payload: NotificationEvent, channel: string) => unknown;
type Unsubscribe = () => Promise<void>;

export interface NotificationBusOptions {
  channel?: string;
  keyPrefix?: string;
  redisUrl?: string;
  logger?: Pick<Console, 'error'>;
  redis?: RedisClientFactory<RedisConnection & Publisher & Subscriber>;
  publisherClient?: Publisher;
  subscriberClient?: Subscriber;
}

export function createNotificationEventBus({
  channel, keyPrefix, redisUrl, logger = console, redis, publisherClient, subscriberClient,
}: NotificationBusOptions = {}) {
  const notificationChannel = channel || buildNotificationChannel(keyPrefix);
  const injectedSubscriptions = new Set<Unsubscribe>();
  const ownedConnections = new Set<RedisConnection>();
  let publisherClientPromise: Promise<Publisher> | undefined;
  let subscriberClientPromise: Promise<Subscriber> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  async function connect() {
    const options = { url: redisUrl, logger };
    const client = redis ? await createPresenceRedisClient({ ...options, redis }) : await createPresenceRedisClient(options);
    if (closed) {
      destroyRedisConnection(client);
      throw new Error('Notification event bus is closed');
    }
    ownedConnections.add(client);
    return client;
  }

  async function publishNotificationCreated(notification: unknown) {
    if (closed) throw new Error('Notification event bus is closed');
    const client = publisherClient ?? await (publisherClientPromise ??= connect().catch(error => {
      publisherClientPromise = undefined;
      throw error;
    }));
    return client.publish(notificationChannel, encodeNotificationCreated(notification));
  }

  async function subscribeNotificationEvents(handler: EventHandler): Promise<Unsubscribe> {
    if (closed) throw new Error('Notification event bus is closed');
    const subscriber = subscriberClient ?? await (subscriberClientPromise ??= connect().catch(error => {
      subscriberClientPromise = undefined;
      throw error;
    }));

    let active = true;
    const listener: MessageListener = async (message, receivedChannel) => {
      if (closed || !active) return;
      try {
        const payload = decodeNotificationEvent(message);
        if (payload) await handler(payload, receivedChannel);
      } catch (error) {
        logger.error('❌ 通知事件解析失败:', error);
      }
    };
    const unsubscribe: Unsubscribe = async () => {
      if (!active) return;
      active = false;
      injectedSubscriptions.delete(unsubscribe);
      if (!closed || subscriberClient) await subscriber.unsubscribe(notificationChannel, listener);
    };

    await subscriber.subscribe(notificationChannel, listener);
    if (closed) {
      await unsubscribe();
      throw new Error('Notification event bus is closed');
    }
    if (subscriberClient) injectedSubscriptions.add(unsubscribe);
    return unsubscribe;
  }

  async function closeConnections() {
    for (const client of ownedConnections) destroyRedisConnection(client);
    ownedConnections.clear();
    const results = await Promise.allSettled(Array.from(injectedSubscriptions, unsubscribe => unsubscribe()));
    await Promise.allSettled([publisherClientPromise, subscriberClientPromise]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Notification subscriptions could not close');
  }

  return {
    publishNotificationCreated,
    subscribeNotificationEvents,
    close() {
      closed = true;
      return closing ??= closeConnections();
    },
  };
}

let legacyBus: ReturnType<typeof createNotificationEventBus> | undefined;
export function publishNotificationCreated(notification: unknown) {
  return (legacyBus ??= createNotificationEventBus()).publishNotificationCreated(notification);
}
