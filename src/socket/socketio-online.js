/**
 * Socket.IO 版本的在线状态服务
 * 职责：管理用户连接、维护在线用户列表、广播用户上下线通知
 *
 * 日志语义约定（区分"用户"与"连接"）：
 * - 用户(user)：以 userId 为粒度，同一账号多标签页仍算 1 个用户
 * - 连接(connection/socket)：以 socketId 为粒度，同一账号每开一个标签页就多 1 条
 * - 上线 / 离线：仅在用户的"第一条 / 最后一条"连接出现或断开时打印
 * - 接入 / 断开：每次 socket 级的变化都会打印
 */

const { createPresenceRegistry } = require('./presenceRegistry');

/**
 * 初始化 Socket.IO 在线状态服务
 * @param {import('socket.io').Server} io - Socket.IO 服务器实例
 */
const initSocketIOOnline = (io) => {
  const presence = createPresenceRegistry();
  let guestConnectionCount = 0;

  console.log('✅ Socket.IO 在线状态服务已启动（多连接模式：同一 userId 多标签页共存，最后一个连接断开才离线）');

  function broadcastOnline() {
    io.emit('online', {
      userList: presence.serializeUserList(),
    });
  }

  function stats() {
    return `用户 ${presence.size()} 人 / 登录连接 ${presence.totalConnections()} 条 / 观察者 ${guestConnectionCount} 条`;
  }

  io.on('connection', (socket) => {
    const { userName, userId, avatarUrl, isGuest } = socket.handshake.query;

    const guestMode = isGuest === 'true' || !userId || !userName;

    if (guestMode) {
      guestConnectionCount += 1;
      console.log(`👁️ 观察者接入，socketId=${socket.id}（${stats()}）`);

      socket.emit('online', {
        userList: presence.serializeUserList(),
      });

      socket.on('disconnect', (reason) => {
        guestConnectionCount = Math.max(0, guestConnectionCount - 1);
        console.log(`👁️ 观察者断开，socketId=${socket.id}，原因=${reason}（${stats()}）`);
      });
    } else {
      const uid = String(userId);
      const label = `${userName}(${uid})`;

      const { isFirstSocket, userConnectionCount } = presence.addConnection({
        userId: uid,
        socketId: socket.id,
        userName: String(userName),
        avatarUrl: avatarUrl ? String(avatarUrl) : '',
      });

      if (isFirstSocket) {
        console.log(`🟢 用户上线：${label}，socketId=${socket.id}（${stats()}）`);
      } else {
        console.log(`➕ 新增连接：${label}，socketId=${socket.id}（该用户连接 ${userConnectionCount} 条，${stats()}）`);
      }

      broadcastOnline();

      socket.on('disconnect', (reason) => {
        const { removedUser, userConnectionCount: remain } = presence.removeConnection({
          userId: uid,
          socketId: socket.id,
        });

        if (removedUser) {
          console.log(`🔴 用户离线：${label}，socketId=${socket.id}，原因=${reason}（${stats()}）`);
        } else {
          console.log(
            `➖ 关闭连接：${label}，socketId=${socket.id}，原因=${reason}（该用户剩余连接 ${remain} 条，${stats()}）`,
          );
        }

        broadcastOnline();
      });
    }

    socket.on('error', (error) => {
      console.error(`❌ Socket 错误 (${userName ?? 'guest'}):`, error);
    });
  });
};

module.exports = initSocketIOOnline;
