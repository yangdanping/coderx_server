const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/0';

async function createPresenceRedisClient(options = {}) {
  const redis = options.redis || require('redis');
  const logger = options.logger || console;
  const url = options.url || process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const client = redis.createClient({ url });

  client.on('error', (error) => {
    logger.error('❌ Redis 连接错误:', error);
  });

  await client.connect();
  return client;
}

module.exports = {
  DEFAULT_REDIS_URL,
  createPresenceRedisClient,
};
