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
const { authenticateSocketHandshake } = require('./socketAuth');

/**
 * 为异步操作增加超时保护，避免非关键依赖长时间阻塞 Socket.IO 连接握手。
 *
 * @template T
 * @param {Promise<T>} promise - 需要限制耗时的异步操作
 * @param {number} timeoutMs - 超时时间，单位毫秒
 * @param {string} message - 超时时抛出的错误消息
 * @returns {Promise<T>} 原始异步操作的结果
 * @throws {Error} 当异步操作超时，或原始 promise reject 时抛出
 */
function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 按用户 ID 从后端资料服务补齐在线列表头像。
 *
 * 头像只是在线列表展示字段，不参与身份判断；因此资料查询失败、数据库暂时不可用、
 * 或查询超时时都兜底为空字符串，避免影响已通过 JWT 鉴权的用户上线。
 *
 * @param {Object} params
 * @param {string} params.userId - 已通过 JWT 鉴权的用户 ID
 * @param {{ getProfileById: (userId: string) => Promise<{ avatarUrl?: string } | null | undefined> }} params.userService - 用户资料服务
 * @param {number} params.timeoutMs - 用户资料查询超时时间，单位毫秒
 * @returns {Promise<string>} 用户头像地址；无法取得时返回空字符串
 */
async function resolvePresenceAvatarUrl({ userId, userService, timeoutMs }) {
  try {
    const profile = await withTimeout(
      Promise.resolve().then(() => userService.getProfileById(userId)),
      timeoutMs,
      `profile lookup timeout after ${timeoutMs}ms`,
    );
    return typeof profile?.avatarUrl === 'string' ? profile.avatarUrl : '';
  } catch (error) {
    console.warn(`⚠️ 在线状态头像查询失败，userId=${userId}，原因=${error.message}`);
    return '';
  }
}

/**
 * 初始化 Socket.IO 在线状态服务
 * @param {import('socket.io').Server} io - Socket.IO 服务器实例
 */
const initSocketIOOnline = (io, options = {}) => {
  const presence = createPresenceRegistry();
  let guestConnectionCount = 0;
  const userService = options.userService || require('@/service/user.service');
  const profileLookupTimeoutMs = options.profileLookupTimeoutMs ?? 800;

  console.log('✅ Socket.IO 在线状态服务已启动（多连接模式：同一 userId 多标签页共存，最后一个连接断开才离线）');

  function broadcastOnline() {
    io.emit('online', {
      userList: presence.serializeUserList(),
    });
  }

  function stats() {
    return `用户 ${presence.size()} 人 / 登录连接 ${presence.totalConnections()} 条 / 观察者 ${guestConnectionCount} 条`;
  }

  io.use(async (socket, next) => {
    try {
      const presenceAuth = authenticateSocketHandshake(socket.handshake);
      if (presenceAuth.mode === 'user') {
        presenceAuth.avatarUrl = await resolvePresenceAvatarUrl({
          userId: presenceAuth.userId,
          userService,
          timeoutMs: profileLookupTimeoutMs,
        });
      }
      socket.data.presenceAuth = presenceAuth;
      next();
    } catch (error) {
      console.warn(`⚠️ Socket.IO 鉴权失败，socketId=${socket.id}，原因=${error.message}`);
      next(error);
    }
  });

  io.on('connection', (socket) => {
    const presenceAuth = socket.data.presenceAuth || { mode: 'guest' };

    if (presenceAuth.mode === 'guest') {
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
      const uid = presenceAuth.userId;
      const label = `${presenceAuth.userName}(${uid})`;

      const { isFirstSocket, userConnectionCount } = presence.addConnection({
        userId: uid,
        socketId: socket.id,
        userName: presenceAuth.userName,
        avatarUrl: presenceAuth.avatarUrl,
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
          console.log(`➖ 关闭连接：${label}，socketId=${socket.id}，原因=${reason}（该用户剩余连接 ${remain} 条，${stats()}）`);
        }

        broadcastOnline();
      });
    }

    socket.on('error', (error) => {
      const label = presenceAuth.mode === 'user' ? presenceAuth.userName : 'guest';
      console.error(`❌ Socket 错误 (${label}):`, error);
    });
  });
};

module.exports = initSocketIOOnline;
