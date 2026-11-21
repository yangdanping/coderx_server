import { createClient as createRedisClient } from 'redis';
import { buildNotificationChannel, encodeNotificationCreated } from './notificationEvent.js';
import { DEFAULT_REDIS_URL } from '../redis/redisClient.js';

type PublisherClient = {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  on(event: 'connect', listener: () => void): unknown;
  connect(): Promise<unknown>;
  publish(channel: string, payload: string): Promise<number>;
  destroy(): void;
};

interface PublisherOptions {
  redisUrl?: string;
  keyPrefix: string;
  logError: () => void;
  createClient?: (url: string) => PublisherClient;
}

export function createNotificationPublisher({ redisUrl, keyPrefix, logError, createClient }: PublisherOptions) {
  const channel = buildNotificationChannel(keyPrefix);
  let current: { client: PublisherClient; connected: boolean } | undefined;
  let connecting: Promise<PublisherClient> | undefined;
  let closed = false;

  function makeClient(url: string): PublisherClient {
    if (createClient) return createClient(url);
    const publisher = createRedisClient({ url, socket: { reconnectStrategy: false } });
    publisher.on('error', logError);
    return publisher;
  }

  async function readyClient(): Promise<PublisherClient> {
    if (closed) throw new Error('Notification publisher is closed');
    if (connecting) return connecting;
    if (current?.client.isReady) return current.client;
    if (current?.client.isOpen) current.client.destroy();
    const client = makeClient(redisUrl || DEFAULT_REDIS_URL);
    const attempt = { client, connected: false };
    current = attempt;
    client.on('connect', () => {
      attempt.connected = true;
      if (closed && client.isOpen) client.destroy();
    });
    connecting = client.connect().then(() => client).finally(() => { connecting = undefined; });
    return connecting;
  }

  return {
    async publishNotificationCreated(notification: unknown) {
      const publisher = await readyClient();
      if (closed) throw new Error('Notification publisher is closed');
      return publisher.publish(channel, encodeNotificationCreated(notification));
    },

    async close() {
      closed = true;
      // Reject in-flight commands so HTTP draining can also complete during a Redis outage.
      // Redis cannot destroy a connecting TCP socket until it exposes it via 'connect'.
      if (current?.client.isOpen && (current.connected || current.client.isReady)) current.client.destroy();
      await connecting?.catch(() => {});
      current = undefined;
    },
  };
}
