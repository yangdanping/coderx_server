const { createPresenceRegistry } = require('./presenceRegistry');
const { createPresenceRedisClient } = require('../redis/redisClient');
const { createRedisPresenceStore } = require('./redisPresenceStore');

/**
 * presence store 工厂。
 *
 * 根据 PRESENCE_STORE=memory|redis 创建对应的在线状态存储实现，
 * 让上层在线状态服务不需要关心数据到底存在内存还是 Redis。
 */
const SUPPORTED_STORE_TYPES = new Set(['memory', 'redis']);
const SUPPORTED_STORE_TYPE_LABEL = Array.from(SUPPORTED_STORE_TYPES).join(', ');

function resolveStoreType(options = {}) {
  return String(options.storeType || process.env.PRESENCE_STORE || 'memory')
    .trim()
    .toLowerCase();
}

function createPresenceStore(options = {}) {
  const storeType = resolveStoreType(options);

  if (!SUPPORTED_STORE_TYPES.has(storeType)) {
    throw new Error(`Unsupported PRESENCE_STORE "${storeType}". Supported values: ${SUPPORTED_STORE_TYPE_LABEL}`);
  }

  if (storeType === 'memory') {
    return createPresenceRegistry();
  }

  if (storeType === 'redis') {
    return createRedisPresenceStore({
      redisClient: options.redisClient,
      keyPrefix: options.keyPrefix,
      socketTtlSeconds: options.socketTtlSeconds,
    });
  }
}

async function createConfiguredPresenceStore(options = {}) {
  const storeType = resolveStoreType(options);

  if (storeType === 'memory') return createPresenceStore({ storeType: 'memory' });

  if (storeType === 'redis') {
    const redisClient =
      options.redisClient ||
      (await createPresenceRedisClient({
        redis: options.redis,
        url: options.redisUrl,
        logger: options.logger,
      }));

    return createPresenceStore({
      storeType,
      redisClient,
      keyPrefix: options.keyPrefix,
      socketTtlSeconds: options.socketTtlSeconds,
    });
  }

  return createPresenceStore({ storeType });
}

module.exports = {
  createConfiguredPresenceStore,
  createPresenceStore,
};
