/**
 * 单机内存版在线 presence 注册表
 * - 用户级展示：对外序列化时每个 userId 一条记录
 * - 连接级记账：同一 userId 可对应多个 socketId，仅当最后一个连接断开时才视为离线
 *
 * 二期扩展：可将本模块替换为 Redis 等外部存储，保持 serializeUserList 的 DTO 形状稳定。
 */

/**
 * @typedef {Object} OnlineUserDTO
 * @property {string} userId
 * @property {string} userName
 * @property {string} avatarUrl
 * @property {string} status
 * @property {string} connectedAt
 */

/**
 * @returns {{
 *   addConnection: (p: { userId: string, socketId: string, userName: string, avatarUrl?: string }) => { isFirstSocket: boolean, userConnectionCount: number },
 *   removeConnection: (p: { userId: string, socketId: string }) => { removedUser: boolean, hadEntry: boolean, userConnectionCount: number },
 *   serializeUserList: () => OnlineUserDTO[],
 *   size: () => number,
 *   totalConnections: () => number,
 * }}
 */
function createPresenceRegistry() {
  /** @type {Map<string, { userName: string, userId: string, avatarUrl: string, status: string, connectedAt: string, socketIds: Set<string> }>} */
  const byUserId = new Map();

  function addConnection({ userId, socketId, userName, avatarUrl = '' }) {
    let entry = byUserId.get(userId);
    const isFirstSocket = !entry;
    if (!entry) {
      entry = {
        userName,
        userId,
        avatarUrl: avatarUrl || '',
        status: 'online',
        connectedAt: new Date().toISOString(),
        socketIds: new Set(),
      };
      byUserId.set(userId, entry);
    }
    entry.socketIds.add(socketId);
    entry.userName = userName;
    if (avatarUrl) entry.avatarUrl = avatarUrl;
    return { isFirstSocket, userConnectionCount: entry.socketIds.size };
  }

  function removeConnection({ userId, socketId }) {
    const entry = byUserId.get(userId);
    if (!entry) return { removedUser: false, hadEntry: false, userConnectionCount: 0 };
    entry.socketIds.delete(socketId);
    if (entry.socketIds.size === 0) {
      byUserId.delete(userId);
      return { removedUser: true, hadEntry: true, userConnectionCount: 0 };
    }
    return { removedUser: false, hadEntry: true, userConnectionCount: entry.socketIds.size };
  }

  function serializeUserList() {
    return Array.from(byUserId.values()).map((e) => ({
      userId: e.userId,
      userName: e.userName,
      avatarUrl: e.avatarUrl,
      status: e.status,
      connectedAt: e.connectedAt,
    }));
  }

  function size() {
    return byUserId.size;
  }

  function totalConnections() {
    let sum = 0;
    for (const entry of byUserId.values()) sum += entry.socketIds.size;
    return sum;
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
  createPresenceRegistry,
};
