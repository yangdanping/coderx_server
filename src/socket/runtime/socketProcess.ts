import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import type { TokenVerificationKey } from '../../auth/verifyUserToken.js';
import { buildAllowedOrigins } from '../../constants/corsOrigins.js';
import { configureSocketRedisAdapter } from '../adapter/socketRedisAdapter.js';
import { createSocketAuthenticator } from '../auth/socketAuth.factory.js';
import { createNotificationEventBus } from '../notification/notificationEventBus.js';
import initializeSocketNotifications, { type NotificationOptions } from '../notification/socketio-notification.js';
import initializeOnlinePresence, { type OnlinePresenceOptions } from '../online/socketio-online.js';
import type { Closable, SocketServer } from './socket.types.js';
import { startSocketServer } from './socketServerRuntime.js';

type SocketNotificationBus = NotificationOptions['eventBus'] &
  Partial<Pick<ReturnType<typeof createNotificationEventBus>, 'publishNotificationCreated' | 'close'>>;

export interface SocketProcessOptions {
  port?: number;
  host?: string;
  publicKey?: TokenVerificationKey;
  userService?: OnlinePresenceOptions['userService'];
  presenceStoreOptions?: OnlinePresenceOptions['presenceStoreOptions'];
  eventBus?: NotificationOptions['eventBus'];
  configureRedisAdapter?: typeof configureSocketRedisAdapter;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export async function startConfiguredSocket({
  port = Number(process.env.SOCKET_PORT || 8001),
  host,
  publicKey = readFileSync(resolve(process.cwd(), process.env.JWT_PUBLIC_KEY_PATH || 'src/app/keys/public.key')),
  userService,
  presenceStoreOptions,
  eventBus,
  configureRedisAdapter = configureSocketRedisAdapter,
  logger = console,
}: SocketProcessOptions = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('SOCKET_PORT is invalid');
  const redirectURL = (process.env.FRONTEND_URL || `${process.env.APP_HOST}:${process.env.ASSETS_PORT}`).replace(/\/+$/, '');
  const redisUrl = process.env.REDIS_URL;
  const keyPrefix = process.env.REDIS_KEY_PREFIX || 'coderx';
  const notificationBus: SocketNotificationBus = eventBus ?? createNotificationEventBus({ keyPrefix, redisUrl, logger });
  const closeEventBus = eventBus ? undefined : notificationBus.close;
  let database: { end(): Promise<void> } | undefined;
  let runtime: Closable | undefined;
  let closing: Promise<void> | undefined;

  async function closeResources() {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => database?.end()),
      Promise.resolve().then(() => closeEventBus?.()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Socket dependencies could not close');
  }

  async function dispose() {
    try {
      await runtime?.close();
    } finally {
      await closeResources();
    }
  }

  try {
    if (!userService) {
      const [{ createPgClient }, { default: { sqlLogger } }, { createUserService }, { createNotificationService }] = await Promise.all([
        import('../../app/database/pg.factory.js'),
        import('../../app/logger.js'),
        import('../../service/user.factory.js'),
        import('../../service/notification.factory.js'),
      ]);
      const connection = createPgClient(process.env, sqlLogger);
      database = connection;
      const baseURL = (process.env.PUBLIC_API_ORIGIN || `${process.env.APP_HOST}:${process.env.APP_PORT}`).replace(/\/+$/, '');
      userService = createUserService({
        connection,
        baseURL,
        notificationService: createNotificationService(connection, baseURL),
        publishNotificationCreated: async notification => notificationBus.publishNotificationCreated?.(notification),
      });
    }

    const httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'socket-server' }));
      } else {
        res.writeHead(404);
        res.end('Socket Server - Use WebSocket connection');
      }
    });

    const io: SocketServer = new Server(httpServer, {
      cors: { origin: buildAllowedOrigins(redirectURL), credentials: true, methods: ['GET', 'POST'] },
      pingTimeout: 60_000,
      pingInterval: 25_000,
    });
    const running = await startSocketServer({
      httpServer,
      io,
      port,
      host,
      redirectURL,
      logger,
      configureRedisAdapter: target => configureRedisAdapter(target, { redisUrl, logger }),
      initializeOnlinePresence,
      onlinePresenceOptions: {
        authenticateSocketHandshake: createSocketAuthenticator({ publicKey }),
        userService,
        logger,
        presenceStoreOptions: { keyPrefix, redisUrl, logger, ...presenceStoreOptions },
      },
      initializeNotifications: initializeSocketNotifications,
      notificationOptions: { eventBus: notificationBus, closeEventBus, logger },
    });
    runtime = running;
    return { ...running, close: () => closing ??= dispose() };
  } catch (error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Socket startup cleanup failed');
    }
    throw error;
  }
}
