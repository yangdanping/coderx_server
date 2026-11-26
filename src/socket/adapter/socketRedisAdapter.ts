import { createAdapter as redisAdapter } from '@socket.io/redis-adapter';
import { createSocketRedisClient, DEFAULT_REDIS_URL, destroyRedisConnection, type RedisClientFactory, type RedisConnection } from '../redis/redisClient.js';
import { resolveRedisAdapterMode } from '../runtime/socketRuntimeConfig.js';
import type { Closable, SocketServer } from '../runtime/socket.types.js';

interface AdapterRedisConnection extends RedisConnection {
  duplicate(): AdapterRedisConnection;
}

interface RedisAdapterOptions {
  enabled?: boolean;
  redisUrl?: string;
  redis?: RedisClientFactory<AdapterRedisConnection>;
  createAdapter?: (pubClient: AdapterRedisConnection, subClient: AdapterRedisConnection) => ReturnType<typeof redisAdapter>;
  logger?: Pick<Console, 'error'>;
}

export type AdapterRuntime = { enabled: false } |
  ({ enabled: true; pubClient: AdapterRedisConnection; subClient: AdapterRedisConnection } & Closable);

export { resolveRedisAdapterMode as resolveRedisAdapterEnabled };

function redisAdapterClient(client: ReturnType<typeof createSocketRedisClient>, logger: Pick<Console, 'error'>) {
  // The adapter invokes these commands without awaiting them, including unsubscribe on close.
  function observe<Args extends unknown[], Result>(command: (...args: Args) => Promise<Result>) {
    return (...args: Args) => {
      const result = command(...args);
      void result.catch(error => {
        if (client.isOpen) logger.error('❌ Socket.IO Redis Adapter 命令失败:', error);
      });
      return result;
    };
  }

  return {
    on: client.on.bind(client),
    off: client.off.bind(client),
    sendCommand: client.sendCommand.bind(client),
    publish: observe(client.publish.bind(client)),
    pSubscribe: observe(client.pSubscribe.bind(client)),
    subscribe: observe(client.subscribe.bind(client)),
    pUnsubscribe: observe(client.pUnsubscribe.bind(client)),
    unsubscribe: observe(client.unsubscribe.bind(client)),
  };
}

export async function configureSocketRedisAdapter(
  io: Pick<SocketServer, 'adapter'>,
  { enabled, redis, redisUrl, createAdapter, logger = console }: RedisAdapterOptions = {},
): Promise<AdapterRuntime> {
  if (!resolveRedisAdapterMode({ enabled })) return { enabled: false };

  const url = redisUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL;
  if (redis) {
    const pubClient = redis.createClient({ url });
    return connectAdapter(io, pubClient, pubClient.duplicate(), createAdapter ?? redisAdapter, logger);
  }

  // Independent connections keep their initial connect/reconnect state separate.
  const pubClient = createSocketRedisClient({ url });
  const subClient = createSocketRedisClient({ url });
  return connectAdapter(io, pubClient, subClient, createAdapter ?? (() =>
    redisAdapter(redisAdapterClient(pubClient, logger), redisAdapterClient(subClient, logger))), logger);
}

async function connectAdapter(
  io: Pick<SocketServer, 'adapter'>,
  pubClient: AdapterRedisConnection,
  subClient: AdapterRedisConnection,
  createAdapter: NonNullable<RedisAdapterOptions['createAdapter']>,
  logger: Pick<Console, 'error'>,
): Promise<AdapterRuntime> {
  pubClient.on('error', error => logger.error('❌ Socket.IO Redis Adapter pub client 错误:', error));
  subClient.on('error', error => logger.error('❌ Socket.IO Redis Adapter sub client 错误:', error));

  function close() {
    destroyRedisConnection(pubClient);
    destroyRedisConnection(subClient);
  }

  try {
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    return { enabled: true, pubClient, subClient, close };
  } catch (error) {
    close();
    throw new Error(`Socket.IO Redis Adapter 初始化失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
