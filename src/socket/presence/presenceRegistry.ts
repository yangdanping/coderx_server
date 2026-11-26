import type { ConnectionId, OnlineUser, PresenceConnection } from './presence.types.js';

// Keeps one entry per user while tracking each connected tab/device by socket ID.
export function createPresenceRegistry() {
  const byUserId = new Map<string, OnlineUser & { socketIds: Set<string> }>();

  function addConnection({ userId, socketId, userName, avatarUrl = '' }: PresenceConnection) {
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

  function refreshConnection({ userId, socketId }: ConnectionId) {
    return byUserId.get(userId)?.socketIds.has(socketId) || false;
  }

  function removeConnection({ userId, socketId }: ConnectionId) {
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
    refreshConnection,
    removeConnection,
    serializeUserList,
    size,
    totalConnections,
  };
}
