const { createPresenceRedisClient } = require('../redis/redisClient');

const NOTIFICATION_NEW_EVENT = 'notification:new';

function buildNotificationChannel(keyPrefix = process.env.REDIS_KEY_PREFIX || 'coderx') {
  return `${keyPrefix}:notification:new`;
}

function createNotificationEventBus(options = {}) {
  const channel = options.channel || buildNotificationChannel(options.keyPrefix);
  const logger = options.logger || console;
  let publisherClientPromise = null;
  let subscriberClientPromise = null;

  async function createRedisClient() {
    return createPresenceRedisClient({
      redis: options.redis,
      url: options.redisUrl,
      logger,
    });
  }

  async function getPublisherClient() {
    if (options.publisherClient) return options.publisherClient;
    if (!publisherClientPromise) {
      publisherClientPromise = createRedisClient();
    }
    return publisherClientPromise;
  }

  async function getSubscriberClient() {
    if (options.subscriberClient) return options.subscriberClient;
    if (!subscriberClientPromise) {
      subscriberClientPromise = (async () => {
        const baseClient = await createRedisClient();
        const subscriber = baseClient.duplicate();
        subscriber.on('error', (error) => {
          logger.error('❌ Redis 通知订阅连接错误:', error);
        });
        await subscriber.connect();
        return subscriber;
      })();
    }
    return subscriberClientPromise;
  }

  async function publishNotificationCreated(notification) {
    const client = await getPublisherClient();
    const payload = JSON.stringify({
      event: NOTIFICATION_NEW_EVENT,
      notification,
    });
    return client.publish(channel, payload);
  }

  async function subscribeNotificationEvents(handler) {
    const subscriber = await getSubscriberClient();
    await subscriber.subscribe(channel, async (message, receivedChannel) => {
      try {
        const payload = JSON.parse(message);
        if (payload?.event !== NOTIFICATION_NEW_EVENT || !payload.notification) return;
        await handler(payload, receivedChannel);
      } catch (error) {
        logger.error('❌ 通知事件解析失败:', error);
      }
    });

    return async () => {
      if (typeof subscriber.unsubscribe === 'function') {
        await subscriber.unsubscribe(channel);
      }
    };
  }

  return {
    publishNotificationCreated,
    subscribeNotificationEvents,
  };
}

const defaultBus = createNotificationEventBus();

module.exports = {
  NOTIFICATION_NEW_EVENT,
  buildNotificationChannel,
  createNotificationEventBus,
  publishNotificationCreated: defaultBus.publishNotificationCreated,
  subscribeNotificationEvents: defaultBus.subscribeNotificationEvents,
};
