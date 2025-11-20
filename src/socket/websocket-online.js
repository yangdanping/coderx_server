/**
 * 原生 WebSocket 版本的在线状态服务
 * 职责：管理 WebSocket 连接、维护在线用户列表、广播用户上下线通知
 * 注意：原生 WebSocket 需要手动处理消息格式、重连等逻辑
 */

const WebSocket = require('ws');
const url = require('url');

/**
 * 初始化原生 WebSocket 在线状态服务
 * @param {import('http').Server} httpServer - HTTP 服务器实例
 */
function initWebSocketOnline(httpServer) {
  // 创建 WebSocket 服务器，挂载到 /online 路径
  const wss = new WebSocket.Server({
    server: httpServer,
    path: '/online'
  });

  // 使用 Map 存储在线用户
  // key: userId, value: { ws, userName, userId, status, connectedAt }
  const onlineUsers = new Map();

  console.log('✅ WebSocket 在线状态服务已启动 (路径: /online)');

  /**
   * 广播消息给所有在线用户和游客
   */
  function broadcast(data) {
    const message = JSON.stringify(data);
    // 遍历所有在线用户，发送消息
    onlineUsers.forEach((user) => {
      // 确保连接是打开状态
      if (user.ws.readyState === WebSocket.OPEN) {
        user.ws.send(message);
      }
    });

    // 同时向所有游客广播
    if (wss.guests) {
      wss.guests.forEach((guestWs) => {
        if (guestWs.readyState === WebSocket.OPEN) {
          guestWs.send(message);
        }
      });
    }
  }

  // 监听客户端连接
  wss.on('connection', (ws, request) => {
    // 从 URL 查询参数中解析用户信息
    const params = url.parse(request.url, true).query;
    const { userName, userId, avatarUrl, isGuest } = params;

    // 判断是否为游客模式
    const guestMode = isGuest === 'true' || !userId || !userName;

    if (guestMode) {
      // 游客模式：只接收在线列表，不显示在列表中
      console.log(`👁️ 观察者通过 WebSocket 连接（不显示在在线列表中）`);

      // 立即向游客发送当前在线用户列表
      const message = JSON.stringify({
        type: 'online',
        userList: Array.from(onlineUsers.values()).map((user) => ({
          userName: user.userName,
          userId: user.userId,
          avatarUrl: user.avatarUrl,
          status: user.status,
          connectedAt: user.connectedAt
        }))
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }

      // 将游客的 ws 保存（用于接收广播，但不加入在线列表）
      // 使用一个临时 Set 存储游客连接
      if (!wss.guests) {
        wss.guests = new Set();
      }
      wss.guests.add(ws);

      // 游客断开连接
      ws.on('close', () => {
        console.log(`👁️ 观察者断开 WebSocket 连接`);
        wss.guests.delete(ws);
      });

      ws.on('error', (error) => {
        console.error(`❌ 观察者 WebSocket 错误:`, error);
      });
    } else {
      // 正式用户模式：显示在在线列表中
      console.log(`✅ 用户 ${userName}(${userId}) 通过 WebSocket 连接`);

      // 将用户添加到在线列表
      onlineUsers.set(userId, {
        ws: ws, // 保存 WebSocket 连接对象
        userName: userName,
        userId: userId,
        avatarUrl: avatarUrl || '', // 存储头像 URL
        status: 'online',
        connectedAt: new Date().toISOString()
      });

      console.log(`📊 当前在线用户数: ${onlineUsers.size}`);

      // 广播最新在线用户列表（包括给游客）
      broadcast({
        type: 'online',
        userList: Array.from(onlineUsers.values()).map((user) => ({
          userName: user.userName,
          userId: user.userId,
          avatarUrl: user.avatarUrl, // 包含头像 URL
          status: user.status,
          connectedAt: user.connectedAt
        }))
      });

      // 监听客户端消息（当前功能不需要处理客户端消息）
      ws.on('message', (data) => {
        console.log(`📩 收到来自 ${userName} 的消息:`, data.toString());
      });

      // 监听连接关闭
      ws.on('close', (code, reason) => {
        console.log(`❌ 用户 ${userName}(${userId}) 断开 WebSocket 连接，代码: ${code}，原因: ${reason || '无'}`);

        // 从在线列表中移除
        onlineUsers.delete(userId);

        console.log(`📊 当前在线用户数: ${onlineUsers.size}`);

        // 广播最新在线用户列表
        broadcast({
          type: 'online',
          userList: Array.from(onlineUsers.values()).map((user) => ({
            userName: user.userName,
            userId: user.userId,
            avatarUrl: user.avatarUrl, // 包含头像 URL
            status: user.status,
            connectedAt: user.connectedAt
          }))
        });
      });

      // 监听连接错误
      ws.on('error', (error) => {
        console.error(`❌ WebSocket 错误 (${userName}):`, error);
      });
    }
  });

  // 监听服务器错误
  wss.on('error', (error) => {
    console.error('❌ WebSocket 服务器错误:', error);
  });

  return wss;
}

module.exports = initWebSocketOnline;
