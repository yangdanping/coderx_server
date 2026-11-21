import { createClient } from 'redis';

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/0';

export interface RedisConnection {
  readonly isOpen: boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(): Promise<unknown>;
  destroy(): void;
}

export interface RedisClientFactory<Client extends RedisConnection> {
  createClient(options: { url: string }): Client;
}

interface BaseOptions {
  url?: string;
  logger?: Pick<Console, 'error'>;
}

export function createSocketRedisClient({ url }: { url: string }) {
  let connected = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      reconnectStrategy: retries => connected ? Math.min(50 * 2 ** retries, 2000) + Math.floor(Math.random() * 200) : false,
    },
  });
  client.once('ready', () => { connected = true; });
  return client;
}

export function createPresenceRedisClient(options?: BaseOptions): Promise<ReturnType<typeof createSocketRedisClient>>;
export function createPresenceRedisClient<Client extends RedisConnection>(
  options: BaseOptions & { redis: RedisClientFactory<Client> },
): Promise<Client>;
export async function createPresenceRedisClient<Client extends RedisConnection>({
  redis, url, logger = console,
}: BaseOptions & { redis?: RedisClientFactory<Client> } = {}) {
  const create = redis ? redis.createClient.bind(redis) : createSocketRedisClient;
  const client = create({ url: url || process.env.REDIS_URL || DEFAULT_REDIS_URL });
  client.on('error', error => logger.error('❌ Redis 连接错误:', error));

  try {
    await client.connect();
    return client;
  } catch (error) {
    destroyRedisConnection(client);
    throw error;
  }
}

export function destroyRedisConnection(client: RedisConnection) {
  if (client.isOpen) client.destroy();
}
