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

  async function removeUserPresence(userId) {
    await redisClient.sRem(keys.users, userId);
    await redisClient.del(keys.user(userId), keys.userSockets(userId));
  }

  async function pruneExpiredUserSockets(userId) {
    const socketsKey = keys.userSockets(userId);
    const socketIds = await redisClient.sMembers(socketsKey);
    let activeSocketCount = 0;

    for (const socketId of socketIds) {
      const socketHash = await redisClient.hGetAll(keys.socket(socketId));
      if (socketHash.socketId === socketId && socketHash.userId === String(userId)) {
        activeSocketCount += 1;
      } else {
        await redisClient.sRem(socketsKey, socketId);
      }
    }

    if (activeSocketCount === 0) {
      await removeUserPresence(userId);
    }

    return activeSocketCount;
  }

  async function addConnection(payload) {
    const { userId, socketId, userName, avatarUrl } = normalizeConnectionPayload(payload);
    const socketsKey = keys.userSockets(userId);
    const userKey = keys.user(userId);
    const socketKey = keys.socket(socketId);
    const previousConnectionCount = await pruneExpiredUserSockets(userId);
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

  async function refreshConnection({ userId, socketId }) {
    const normalizedUserId = String(userId);
    const normalizedSocketId = String(socketId);
    const socketIds = await redisClient.sMembers(keys.userSockets(normalizedUserId));
    if (!socketIds.includes(normalizedSocketId)) return false;

    await redisClient.hSet(keys.socket(normalizedSocketId), {
      userId: normalizedUserId,
      socketId: normalizedSocketId,
    });
    await redisClient.expire(keys.socket(normalizedSocketId), socketTtlSeconds);
    return true;
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
      await removeUserPresence(normalizedUserId);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    }

    return { removedUser: false, hadEntry: true, userConnectionCount: nextConnectionCount };
  }

  async function serializeUserList() {
    const userIds = await redisClient.sMembers(keys.users);
    const users = [];

    for (const userId of userIds) {
      const activeSocketCount = await pruneExpiredUserSockets(userId);
      if (activeSocketCount === 0) continue;

      const userHash = await redisClient.hGetAll(keys.user(userId));
      if (!userHash.userId) {
        await removeUserPresence(userId);
        continue;
      }

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
    const userIds = await redisClient.sMembers(keys.users);
    let total = 0;

    for (const userId of userIds) {
      if ((await pruneExpiredUserSockets(userId)) > 0) total += 1;
    }

    return total;
  }

  async function totalConnections() {
    const userIds = await redisClient.sMembers(keys.users);
    let total = 0;

    for (const userId of userIds) {
      total += await pruneExpiredUserSockets(userId);
    }

    return total;
  }

  return {
    addConnection,
    refreshConnection,
    removeConnection,
    serializeUserList,
    size,
    totalConnections,
  };
}

module.exports = {
  createRedisPresenceStore,
};
