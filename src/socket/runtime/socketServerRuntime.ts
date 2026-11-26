import type { Server as HttpServer } from 'node:http';
import type { OnlinePresenceOptions } from '../online/socketio-online.js';
import type { NotificationOptions } from '../notification/socketio-notification.js';
import { describeSocketRuntimeMode } from './socketRuntimeConfig.js';
import type { Close, Closable, SocketServer } from './socket.types.js';

interface SocketStartupOptions {
  httpServer: HttpServer;
  io: SocketServer;
  port: number;
  host?: string;
  redirectURL?: string;
  logger?: Pick<Console, 'log'>;
  configureRedisAdapter?: (io: SocketServer) => Promise<({ enabled: boolean } & Partial<Closable>) | void>;
  initializeOnlinePresence: (io: SocketServer, options: OnlinePresenceOptions) => (Closable & { ready?: Promise<unknown> }) | void;
  onlinePresenceOptions: OnlinePresenceOptions;
  initializeNotifications?: (io: SocketServer, options: NotificationOptions) => Promise<Closable | void>;
  notificationOptions?: NotificationOptions;
}

export async function startSocketServer({
  httpServer,
  io,
  port,
  host,
  redirectURL = '',
  logger = console,
  configureRedisAdapter = async () => ({ enabled: false }),
  initializeOnlinePresence,
  onlinePresenceOptions,
  initializeNotifications,
  notificationOptions,
}: SocketStartupOptions) {
  const closeResources: Close[] = [];
  let closing: Promise<void> | undefined;

  async function dispose() {
    // Socket.IO disconnects its clients and closes the HTTP listener.
    const socketResult = await Promise.allSettled([Promise.resolve().then(() => io.close?.())]);
    const results = await Promise.allSettled(closeResources.map(close => Promise.resolve().then(close)));
    const errors = [...socketResult, ...results].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Socket server shutdown failed');
  }

  const close = () => closing ??= dispose();
  try {
    const adapter = await configureRedisAdapter(io);
    if (adapter?.close) closeResources.push(() => adapter.close?.());
    const presence = initializeOnlinePresence(io, onlinePresenceOptions);
    if (presence) closeResources.push(() => presence.close());
    await presence?.ready;
    if (notificationOptions) {
      const notifications = await initializeNotifications?.(io, notificationOptions);
      if (notifications) closeResources.push(() => notifications.close());
    }
    const presenceStoreOptions = onlinePresenceOptions?.presenceStoreOptions;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once?.('error', onError);
      const listening = () => {
        httpServer.off?.('error', onError);
        resolve();
      };
      if (host) httpServer.listen(port, host, listening);
      else httpServer.listen(port, listening);
    });

    const address = httpServer.address?.();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const runtimeMode = describeSocketRuntimeMode({
      presenceStoreType: presenceStoreOptions?.storeType,
      redisAdapterEnabled: adapter?.enabled ?? false,
      redisKeyPrefix: presenceStoreOptions?.keyPrefix,
    });

    logger.log('='.repeat(60));
    logger.log('🚀 Socket.IO 服务器启动成功！');
    logger.log(`📡 监听端口: ${actualPort}`);
    logger.log(`🌐 允许跨域: ${redirectURL}`);
    logger.log('✅ 在线状态服务已启动');
    logger.log(runtimeMode.presenceMessage);
    logger.log(runtimeMode.adapterMessage);
    logger.log(`🔗 健康检查: http://localhost:${actualPort}/health`);
    logger.log('='.repeat(60));

    return { httpServer, io, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Socket server startup cleanup failed');
    }
    throw error;
  }
}
