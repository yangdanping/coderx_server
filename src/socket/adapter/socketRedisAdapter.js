const { DEFAULT_REDIS_URL } = require('../redis/redisClient');

function resolveRedisAdapterEnabled(options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  return String(process.env.SOCKET_REDIS_ADAPTER_ENABLED || 'false').trim().toLowerCase() === 'true';
}

async function quitQuietly(client) {
  if (!client || typeof client.quit !== 'function') return;
  try {
    await client.quit();
  } catch {
    // Startup is already failing; cleanup errors should not hide the root cause.
  }
}

async function configureSocketRedisAdapter(io, options = {}) {
  if (!resolveRedisAdapterEnabled(options)) {
    return { enabled: false };
  }

  const redis = options.redis || require('redis');
  const { createAdapter } = options.createAdapter
    ? { createAdapter: options.createAdapter }
    : require('@socket.io/redis-adapter');
  const logger = options.logger || console;
  const redisUrl = options.redisUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const pubClient = redis.createClient({ url: redisUrl });
  pubClient.on('error', (error) => {
    logger.error('❌ Socket.IO Redis Adapter pub client 错误:', error);
  });
  const subClient = pubClient.duplicate();
  subClient.on('error', (error) => {
    logger.error('❌ Socket.IO Redis Adapter sub client 错误:', error);
  });

  try {
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    return { enabled: true, pubClient, subClient };
  } catch (error) {
    await Promise.all([quitQuietly(pubClient), quitQuietly(subClient)]);
    throw new Error(`Socket.IO Redis Adapter 初始化失败: ${error.message}`, { cause: error });
  }
}

module.exports = {
  configureSocketRedisAdapter,
  resolveRedisAdapterEnabled,
};
