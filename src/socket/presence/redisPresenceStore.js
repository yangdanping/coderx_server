/**
 * Redis 版 presence store 实现。
 *
 * 使用 Redis Hash / Set 保存在线用户和 socket 连接关系，
 * 对外保持和内存版 presence store 一致的接口。
 */

function createKeys(keyPrefix) {
  const prefix = String(keyPrefix || 'coderx').replace(/:+$/, '');

  return {
    users: `${prefix}:presence:users`,
    user: (userId) => `${prefix}:presence:user:${userId}`,
    userSockets: (userId) => `${prefix}:presence:user:${userId}:sockets`,
    socket: (socketId) => `${prefix}:presence:socket:${socketId}`,
  };
}

function normalizeConnectionPayload({ userId, socketId, userName, avatarUrl = '' }) {
  return {
    userId: String(userId),
    socketId: String(socketId),
    userName: String(userName),
    avatarUrl: avatarUrl ? String(avatarUrl) : '',
  };
}

function compareOnlineUsers(a, b) {
  const byConnectedAt = String(a.connectedAt).localeCompare(String(b.connectedAt));
  if (byConnectedAt !== 0) return byConnectedAt;
  return String(a.userId).localeCompare(String(b.userId));
}

function createRedisPresenceStore(options = {}) {
  const redisClient = options.redisClient;
  if (!redisClient) {
    throw new Error('redisPresenceStore requires a redisClient');
  }

  const keys = createKeys(options.keyPrefix || process.env.REDIS_KEY_PREFIX || 'coderx');
  const socketTtlSeconds = options.socketTtlSeconds ?? 90;

  async function addConnection(payload) {
    const { userId, socketId, userName, avatarUrl } = normalizeConnectionPayload(payload);
    const socketsKey = keys.userSockets(userId);
    const userKey = keys.user(userId);
    const socketKey = keys.socket(socketId);
    const previousConnectionCount = await redisClient.sCard(socketsKey);
    const isFirstSocket = previousConnectionCount === 0;
    const existingUser = isFirstSocket ? {} : await redisClient.hGetAll(userKey);
    const connectedAt = existingUser.connectedAt || new Date().toISOString();

    const userHash = {
      userId,
      userName,
      avatarUrl: avatarUrl || existingUser.avatarUrl || '',
      status: 'online',
      connectedAt,
    };

    await redisClient.sAdd(keys.users, userId);
    await redisClient.hSet(userKey, userHash);
    await redisClient.sAdd(socketsKey, socketId);
    await redisClient.hSet(socketKey, { userId, socketId });
    await redisClient.expire(socketKey, socketTtlSeconds);

    return {
      isFirstSocket,
      userConnectionCount: await redisClient.sCard(socketsKey),
    };
  }

  async function removeConnection({ userId, socketId }) {
    const normalizedUserId = String(userId);
    const normalizedSocketId = String(socketId);
    const socketsKey = keys.userSockets(normalizedUserId);
    const previousConnectionCount = await redisClient.sCard(socketsKey);

    if (previousConnectionCount === 0) {
      return { removedUser: false, hadEntry: false, userConnectionCount: 0 };
    }

    await redisClient.sRem(socketsKey, normalizedSocketId);
    await redisClient.del(keys.socket(normalizedSocketId));

    const nextConnectionCount = await redisClient.sCard(socketsKey);
    if (nextConnectionCount === 0) {
      await redisClient.sRem(keys.users, normalizedUserId);
      await redisClient.del(keys.user(normalizedUserId), socketsKey);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    }

    return { removedUser: false, hadEntry: true, userConnectionCount: nextConnectionCount };
  }

  async function serializeUserList() {
    const userIds = await redisClient.sMembers(keys.users);
    const users = [];

    for (const userId of userIds) {
      const userHash = await redisClient.hGetAll(keys.user(userId));
      if (!userHash.userId) continue;

      users.push({
        userId: userHash.userId,
        userName: userHash.userName || '',
        avatarUrl: userHash.avatarUrl || '',
        status: userHash.status || 'online',
        connectedAt: userHash.connectedAt || '',
      });
    }

    return users.sort(compareOnlineUsers);
  }

  async function size() {
    return redisClient.sCard(keys.users);
  }

  async function totalConnections() {
    const userIds = await redisClient.sMembers(keys.users);
    let total = 0;

    for (const userId of userIds) {
      total += await redisClient.sCard(keys.userSockets(userId));
    }

    return total;
  }

  return {
    addConnection,
    removeConnection,
    serializeUserList,
    size,
    totalConnections,
  };
}

module.exports = {
  createRedisPresenceStore,
};
