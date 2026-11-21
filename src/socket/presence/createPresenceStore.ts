import { createPresenceRegistry } from './presenceRegistry.js';
import { createPresenceRedisClient, destroyRedisConnection, type RedisClientFactory, type RedisConnection } from '../redis/redisClient.js';
import { createRedisPresenceStore, type PresenceRedisCommands } from './redisPresenceStore.js';
import { resolvePresenceStoreMode } from '../runtime/socketRuntimeConfig.js';
import type { PresenceStore } from './presence.types.js';
import type { Closable } from '../runtime/socket.types.js';

interface StoreOptions {
  storeType?: string;
  redisClient?: PresenceRedisCommands;
  keyPrefix?: string;
  socketTtlSeconds?: number;
}

export interface ConfiguredPresenceOptions extends StoreOptions {
  redis?: RedisClientFactory<PresenceRedisCommands & RedisConnection>;
  redisUrl?: string;
  logger?: Pick<Console, 'error'>;
}

export function createPresenceStore(options: StoreOptions = {}): PresenceStore {
  const storeType = resolvePresenceStoreMode(options);
  switch (storeType) {
    case 'memory':
      return createPresenceRegistry();
    case 'redis':
      return createRedisPresenceStore(options);
    default:
      throw new Error(`Unsupported PRESENCE_STORE "${storeType}". Supported values: memory, redis`);
  }
}

export async function createConfiguredPresenceStore(options: ConfiguredPresenceOptions = {}): Promise<PresenceStore & Partial<Closable>> {
  const storeType = resolvePresenceStoreMode(options);
  if (storeType !== 'redis' || options.redisClient) return createPresenceStore({ ...options, storeType });

  const connectionOptions = { url: options.redisUrl, logger: options.logger };
  const redisClient = options.redis
    ? await createPresenceRedisClient({ ...connectionOptions, redis: options.redis })
    : await createPresenceRedisClient(connectionOptions);
  return {
    ...createRedisPresenceStore({ ...options, redisClient }),
    close: () => destroyRedisConnection(redisClient),
  };
}
