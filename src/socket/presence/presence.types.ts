type Result<T> = T | Promise<T>;

export interface ConnectionId {
  userId: string;
  socketId: string;
}

export interface PresenceConnection extends ConnectionId {
  userName: string;
  avatarUrl?: string;
}

export interface OnlineUser {
  userId: string;
  userName: string;
  avatarUrl: string;
  status: string;
  connectedAt: string;
}

export interface PresenceStore {
  addConnection(connection: PresenceConnection): Result<{ isFirstSocket: boolean; userConnectionCount: number }>;
  refreshConnection?(connection: ConnectionId): Result<boolean>;
  removeConnection(connection: ConnectionId): Result<{ removedUser: boolean; hadEntry: boolean; userConnectionCount: number }>;
  serializeUserList(): Result<OnlineUser[]>;
  size(): Result<number>;
  totalConnections(): Result<number>;
}
