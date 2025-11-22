/**
 * Socket.IO 版本的在线状态服务
 * 职责：管理用户连接、维护在线用户列表、广播用户上下线通知
 */

/**
 * 初始化 Socket.IO 在线状态服务
 * @param {import('socket.io').Server} io - Socket.IO 服务器实例
 */
const initSocketIOOnline = (io) => {
  // ==================== 在线用户存储结构（方案1：单连接模式） ====================
  // 使用 Map 存储在线用户
  // key: userId（用户唯一标识）
  // value: { socketId, userName, userId, status, connectedAt }
  //
  // 【重要】多设备/多标签页登录行为：
  // - 同一个 userId 只保留最后一次连接（新连接覆盖旧连接）
  // - 无论从 localhost、192.168.3.96 还是手机访问，只要 userId 相同，都会覆盖
  // - 示例：用户在 localhost 登录 → Map['userId1'] = {socketId: 'abc'}
  //        同一用户在 192.168.3.96 登录 → Map['userId1'] = {socketId: 'xyz'} ← 覆盖了！
  // - 结果：前端只显示一个在线状态，关闭任一设备都会显示离线
  // - 这是预期行为，不是 bug！如需支持多设备同时在线，需要改用 socketId 作为 key
  const onlineUsers = new Map();

  console.log('✅ Socket.IO 在线状态服务已启动（单连接模式:同一 userId 只保留最后一次连接）');

  // 监听客户端连接
  io.on('connection', (socket) => {
    // 从连接查询参数中获取用户信息
    const { userName, userId, avatarUrl, isGuest } = socket.handshake.query;

    // 不符合当前需求:验证用户信息不通过则拒绝连接
    // if (!userId || !userName) {
    //   console.log('❌ 用户信息不完整，拒绝连接');
    //   socket.disconnect();
    //   return;
    // }

    // 判断是否为游客模式
    const guestMode = isGuest === 'true' || !userId || !userName;

    if (guestMode) {
      // 游客模式：只接收在线列表，不显示在列表中
      console.log(`👁️ 观察者连接成功，socketId: ${socket.id}（不显示在在线列表中）`);

      // 立即向游客发送当前在线用户列表
      socket.emit('online', {
        userList: Array.from(onlineUsers.values())
      });

      // 游客断开连接时不需要广播（因为他们不在列表中）
      socket.on('disconnect', (reason) => {
        console.log(`👁️ 观察者断开连接，socketId: ${socket.id}，原因: ${reason}`);
      });
    } else {
      // 正式用户模式：显示在在线列表中
      console.log(`✅ 用户 ${userName}(${userId}) 连接成功，socketId: ${socket.id}`);

      // 将用户添加到在线列表
      // ⚠️ 注意：使用 userId 作为 key，所以同一用户的新连接会覆盖旧连接
      // 这意味着：多标签页/多设备登录时，只保留最新的连接信息
      onlineUsers.set(userId, {
        socketId: socket.id,
        userName: userName,
        userId: userId,
        avatarUrl: avatarUrl || '', // 存储头像 URL
        status: 'online',
        connectedAt: new Date().toISOString()
      });

      console.log(`📊 当前在线用户数: ${onlineUsers.size}`);

      // 广播最新在线用户列表给所有客户端（包括游客）
      // io.emit() 发送给所有连接的客户端
      io.emit('online', {
        userList: Array.from(onlineUsers.values()) // 将 Map 转为数组
      });

      // 监听客户端断开连接
      socket.on('disconnect', (reason) => {
        console.log(`❌ 用户 ${userName}(${userId}) 断开连接，原因: ${reason}`);

        // 从在线列表中移除该用户
        onlineUsers.delete(userId);

        console.log(`📊 当前在线用户数: ${onlineUsers.size}`);

        // 再次广播最新在线用户列表
        io.emit('online', {
          userList: Array.from(onlineUsers.values())
        });
      });
    }

    // 监听连接错误
    socket.on('error', (error) => {
      console.error(`❌ Socket 错误 (${userName}):`, error);
    });
  });
};

module.exports = initSocketIOOnline;
