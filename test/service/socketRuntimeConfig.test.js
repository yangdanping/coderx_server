const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeSocketRuntimeMode,
  resolvePresenceStoreMode,
  resolveRedisAdapterMode,
} = require('../../src/socket/socketRuntimeConfig');

test('socketRuntimeConfig: describes Redis presence and adapter runtime mode', () => {
  const runtimeMode = describeSocketRuntimeMode({
    presenceStoreType: 'redis',
    redisAdapterEnabled: true,
    redisKeyPrefix: 'coderx:',
  });

  assert.equal(resolvePresenceStoreMode({ storeType: 'redis' }), 'redis');
  assert.equal(resolveRedisAdapterMode({ enabled: true }), true);
  assert.deepEqual(runtimeMode, {
    presenceStoreType: 'redis',
    redisAdapterEnabled: true,
    redisKeyPrefix: 'coderx',
    presenceMessage: '✅ Presence Store: redis（在线用户/连接记账写入 Redis，key 前缀 coderx:presence:*）',
    adapterMessage: '✅ Socket.IO Redis Adapter: enabled（跨 Socket.IO 实例广播走 Redis Pub/Sub；单实例时主要是预备能力）',
  });
});

test('socketRuntimeConfig: describes memory presence and local adapter runtime mode', () => {
  const runtimeMode = describeSocketRuntimeMode({
    presenceStoreType: 'memory',
    redisAdapterEnabled: false,
  });

  assert.equal(resolvePresenceStoreMode({ storeType: 'memory' }), 'memory');
  assert.equal(resolveRedisAdapterMode({ enabled: false }), false);
  assert.deepEqual(runtimeMode, {
    presenceStoreType: 'memory',
    redisAdapterEnabled: false,
    redisKeyPrefix: 'coderx',
    presenceMessage: 'ℹ️ Presence Store: memory（在线状态仅保存在当前 Node 进程内）',
    adapterMessage: 'ℹ️ Socket.IO Redis Adapter: disabled（广播只覆盖当前 Socket.IO 实例）',
  });
});
