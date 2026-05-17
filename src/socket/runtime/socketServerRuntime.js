const { describeSocketRuntimeMode } = require('./socketRuntimeConfig');

async function startSocketServer({
  httpServer,
  io,
  port,
  redirectURL = '',
  logger = console,
  configureRedisAdapter = async () => ({ enabled: false }),
  initializeOnlinePresence,
  onlinePresenceOptions = {},
  initializeNotifications = async () => {},
  notificationOptions = {},
}) {
  const redisAdapterRuntime = (await configureRedisAdapter(io)) || { enabled: false };
  initializeOnlinePresence(io, onlinePresenceOptions);
  await initializeNotifications(io, notificationOptions);
  const presenceStoreOptions = onlinePresenceOptions.presenceStoreOptions || {};

  await new Promise((resolve) => {
    httpServer.listen(port, () => {
      const runtimeMode = describeSocketRuntimeMode({
        presenceStoreType: presenceStoreOptions.storeType,
        redisAdapterEnabled: redisAdapterRuntime.enabled,
        redisKeyPrefix: presenceStoreOptions.keyPrefix,
      });

      logger.log('='.repeat(60));
      logger.log(`🚀 Socket.IO 服务器启动成功！`);
      logger.log(`📡 监听端口: ${port}`);
      logger.log(`🌐 允许跨域: ${redirectURL}`);
      logger.log(`✅ 在线状态服务已启动`);
      logger.log(runtimeMode.presenceMessage);
      logger.log(runtimeMode.adapterMessage);
      logger.log(`🔗 健康检查: http://localhost:${port}/health`);
      logger.log('='.repeat(60));
      resolve();
    });
  });

  return { httpServer, io };
}

module.exports = {
  startSocketServer,
};
