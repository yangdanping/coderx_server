const REDIS_ADAPTER_ENABLED_MESSAGE =
  '✅ Socket.IO Redis Adapter: enabled（跨 Socket.IO 实例广播走 Redis Pub/Sub；单实例时主要是预备能力）';
const REDIS_ADAPTER_DISABLED_MESSAGE = 'ℹ️ Socket.IO Redis Adapter: disabled（广播只覆盖当前 Socket.IO 实例）';

function normalizeRedisKeyPrefix(value) {
  return String(value || 'coderx').replace(/:+$/, '');
}

function resolvePresenceStoreMode(options = {}) {
  return String(options.storeType || process.env.PRESENCE_STORE || 'memory')
    .trim()
    .toLowerCase();
}

function resolveRedisAdapterMode(options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  return String(process.env.SOCKET_REDIS_ADAPTER_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function describeSocketRuntimeMode(options = {}) {
  const presenceStoreType = resolvePresenceStoreMode({ storeType: options.presenceStoreType });
  const redisAdapterEnabled = resolveRedisAdapterMode({ enabled: options.redisAdapterEnabled });
  const redisKeyPrefix = normalizeRedisKeyPrefix(options.redisKeyPrefix || process.env.REDIS_KEY_PREFIX);
  const presenceMessage =
    presenceStoreType === 'redis'
      ? `✅ Presence Store: redis（在线用户/连接记账写入 Redis，key 前缀 ${redisKeyPrefix}:presence:*）`
      : 'ℹ️ Presence Store: memory（在线状态仅保存在当前 Node 进程内）';

  return {
    presenceStoreType,
    redisAdapterEnabled,
    redisKeyPrefix,
    presenceMessage,
    adapterMessage: redisAdapterEnabled ? REDIS_ADAPTER_ENABLED_MESSAGE : REDIS_ADAPTER_DISABLED_MESSAGE,
  };
}

module.exports = {
  describeSocketRuntimeMode,
  normalizeRedisKeyPrefix,
  resolvePresenceStoreMode,
  resolveRedisAdapterMode,
};
