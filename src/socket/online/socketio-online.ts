import { createConfiguredPresenceStore, type ConfiguredPresenceOptions } from '../presence/createPresenceStore.js';
import type { PresenceStore } from '../presence/presence.types.js';
import type { SocketAuthenticator, UserPresence } from '../auth/socketAuth.factory.js';
import type { Closable, PresenceSocket, SocketServer } from '../runtime/socket.types.js';

interface ProfileLookup {
  getProfileById(userId: string): Promise<{ avatarUrl?: string | null } | null | undefined>;
}

export interface OnlinePresenceOptions {
  authenticateSocketHandshake: SocketAuthenticator;
  userService: ProfileLookup;
  presenceStore?: PresenceStore;
  presenceStoreOptions?: ConfiguredPresenceOptions;
  profileLookupTimeoutMs?: number;
  presenceRefreshIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default function initializeOnlinePresence(io: SocketServer, {
  authenticateSocketHandshake,
  userService,
  presenceStore,
  presenceStoreOptions,
  profileLookupTimeoutMs = 800,
  presenceRefreshIntervalMs = 30_000,
  logger = console,
}: OnlinePresenceOptions) {
  const store: Promise<PresenceStore & Partial<Closable>> = presenceStore
    ? Promise.resolve(presenceStore)
    : createConfiguredPresenceStore(presenceStoreOptions);
  const connections = new Map<string, (reason: string) => Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let guestConnectionCount = 0;

  async function broadcastOnline(presence: PresenceStore) {
    if (!closed) io.emit('online', { userList: await presence.serializeUserList() });
  }

  async function stats(presence: PresenceStore) {
    const [onlineUserCount, loginConnectionCount] = await Promise.all([presence.size(), presence.totalConnections()]);
    return `用户 ${onlineUserCount} 人 / 登录连接 ${loginConnectionCount} 条 / 观察者 ${guestConnectionCount} 条`;
  }

  function logPresenceError(context: string, error: unknown) {
    logger.error(`❌ Socket.IO 在线状态处理失败（${context}）:`, error);
  }

  async function resolveAvatarUrl(userId: string) {
    try {
      const profile = await withTimeout(
        Promise.resolve().then(() => userService.getProfileById(userId)),
        profileLookupTimeoutMs,
        `profile lookup timeout after ${profileLookupTimeoutMs}ms`,
      );
      return typeof profile?.avatarUrl === 'string' ? profile.avatarUrl : '';
    } catch (error) {
      logger.warn(`⚠️ 在线状态头像查询失败，userId=${userId}，原因=${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  async function handleGuestConnection(socket: PresenceSocket) {
    guestConnectionCount += 1;
    let connected = true;
    socket.on('disconnect', async reason => {
      connected = false;
      guestConnectionCount -= 1;
      try {
        logger.log(`👁️ 观察者断开，socketId=${socket.id}，原因=${reason}（${await stats(await store)}）`);
      } catch (error) {
        logPresenceError('guest disconnect', error);
      }
    });

    const presence = await store;
    logger.log(`👁️ 观察者接入，socketId=${socket.id}（${await stats(presence)}）`);
    if (connected && !closed) socket.emit('online', { userList: await presence.serializeUserList() });
  }

  async function handleUserConnection(socket: PresenceSocket, { userId, userName, avatarUrl }: UserPresence) {
    const connection = { userId, socketId: socket.id };
    const label = `${userName}(${userId})`;
    let connected = true;
    let refreshTimer: NodeJS.Timeout | undefined;
    let refresh: Promise<unknown> | undefined;
    let removal: Promise<void> | undefined;
    const registered = store.then(presence => presence.addConnection({ ...connection, userName, avatarUrl }));

    function stop(reason: string) {
      connected = false;
      clearInterval(refreshTimer);
      return removal ??= remove(reason).catch(error => logPresenceError('user disconnect', error))
        .finally(() => { connections.delete(socket.id); });
    }

    async function remove(reason: string) {
      // A socket may disconnect before Redis acknowledges addConnection.
      await registered.catch(() => {});
      await refresh;
      const presence = await store;
      const { removedUser, userConnectionCount } = await presence.removeConnection(connection);
      const status = await stats(presence);
      if (removedUser) {
        logger.log(`🔴 用户离线：${label}，socketId=${socket.id}，原因=${reason}（${status}）`);
      } else {
        logger.log(`➖ 关闭连接：${label}，socketId=${socket.id}，原因=${reason}（该用户剩余连接 ${userConnectionCount} 条，${status}）`);
      }
      await broadcastOnline(presence);
    }

    connections.set(socket.id, stop);
    socket.on('disconnect', stop);
    const [presence, { isFirstSocket, userConnectionCount }] = await Promise.all([store, registered]);
    if (!connected || closed) return;

    if (presence.refreshConnection) {
      refreshTimer = setInterval(() => {
        return refresh ??= Promise.resolve()
          .then(() => presence.refreshConnection?.(connection))
          .catch(error => logPresenceError('refresh connection', error))
          .finally(() => { refresh = undefined; });
      }, presenceRefreshIntervalMs);
      refreshTimer.unref?.();
    }

    const status = await stats(presence);
    if (isFirstSocket) {
      logger.log(`🟢 用户上线：${label}，socketId=${socket.id}（${status}）`);
    } else {
      logger.log(`➕ 新增连接：${label}，socketId=${socket.id}（该用户连接 ${userConnectionCount} 条，${status}）`);
    }
    if (connected) await broadcastOnline(presence);
  }

  io.use(async (socket, next) => {
    try {
      if (closed) throw new Error('Socket server is closing');
      const presenceAuth = authenticateSocketHandshake(socket.handshake);
      if (presenceAuth.mode === 'user') {
        presenceAuth.avatarUrl = await resolveAvatarUrl(presenceAuth.userId);
      }
      socket.data.presenceAuth = presenceAuth;
      next();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      logger.warn(`⚠️ Socket.IO 鉴权失败，socketId=${socket.id}，原因=${failure.message}`);
      next(failure);
    }
  });

  function onConnection(socket: PresenceSocket) {
    if (closed) return;
    const presenceAuth = socket.data.presenceAuth;
    const label = presenceAuth?.mode === 'user' ? presenceAuth.userName : 'guest';
    socket.on('error', error => logger.error(`❌ Socket 错误 (${label}):`, error));
    const handle = presenceAuth?.mode === 'user' ? handleUserConnection(socket, presenceAuth) : handleGuestConnection(socket);
    return handle.catch(error => logPresenceError('connection', error));
  }

  io.on('connection', onConnection);
  logger.log('✅ Socket.IO 在线状态服务已启动（多连接模式：同一 userId 多标签页共存，最后一个连接断开才离线）');

  async function dispose() {
    io.off('connection', onConnection);
    await Promise.all(Array.from(connections.values(), stop => stop('server shutting down')));
    if (!presenceStore) await (await store.catch(() => undefined))?.close?.();
  }

  return {
    ready: store,
    close(): Promise<void> {
      closed = true;
      return closing ??= dispose();
    },
  };
}
