/**
 * 独立的 Socket.IO 服务器
 * 职责：专门处理 WebSocket 连接，不耦合到 Koa 应用
 * 优势：可以独立启动、重启、部署，不影响主应用
 */

require('module-alias/register'); // 注册路径别名 @ -> src
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const path = require('path');

// 加载环境变量
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });
console.log(`Socket Server 正在加载环境变量: ${envFile}`);

const { redirectURL } = require('@/constants/urls');
const { ALLOWED_ORIGINS } = require('@/constants/cors');

// Socket 服务器配置
const SOCKET_PORT = process.env.SOCKET_PORT || 8001; // 独立端口，不占用 Koa 的 APP_PORT(8000)

// 导入在线状态服务
const initSocketIOOnline = require('./socket/socketio-online');

// 创建独立的 HTTP 服务器（不依赖 Koa）
const httpServer = http.createServer((req, res) => {
  // 可选：添加健康检查接口
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'socket-server' }));
  } else {
    res.writeHead(404);
    res.end('Socket Server - Use WebSocket connection');
  }
});

// 初始化 Socket.IO 服务
// 二期扩展：多实例部署时可接入 @socket.io/redis-adapter（Redis Pub/Sub 同步跨节点广播）；
// 全局在线 presence 仍可单独用 Redis Hash/Set + TTL 维护，见前端文档「Redis 二期（预留）」。
const io = new Server(httpServer, {
  cors: {
    // 方案 1：允许多个源（开发环境推荐）
    origin: ALLOWED_ORIGINS,
    // 方案 2：允许所有源（仅用于开发，生产环境不安全！）
    // origin: true,
    // 方案 3：动态验证源（最安全，推荐用于生产环境）
    // origin: (origin, callback) => {
    //   // 允许的源列表
    //   const allowedOrigins = [
    //     'http://localhost:8080',
    //     'http://127.0.0.1:8080',
    //     /^http:\/\/192\.168\.\d+\.\d+:8080$/, // 允许所有 192.168.x.x:8080
    //     process.env.redirectURL,
    //   ];
    //   if (!origin || allowedOrigins.some(allowed =>
    //     typeof allowed === 'string' ? allowed === origin : allowed.test(origin)
    //   )) {
    //     callback(null, true);
    //   } else {
    //     callback(new Error('Not allowed by CORS'));
    //   }
    // },
    credentials: true,
    methods: ['GET', 'POST'],
  },
  // Socket.IO 配置优化
  pingTimeout: 60000, // 60 秒无响应则断开
  pingInterval: 25000, // 每 25 秒发送心跳
});

// 启动在线状态服务
initSocketIOOnline(io);

// 启动服务器
httpServer.listen(SOCKET_PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Socket.IO 服务器启动成功！`);
  console.log(`📡 监听端口: ${SOCKET_PORT}`);
  console.log(`🌐 允许跨域: ${redirectURL}`);
  console.log(`✅ 在线状态服务已启动`);
  console.log(`🔗 健康检查: http://localhost:${SOCKET_PORT}/health`);
  console.log('='.repeat(60));
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('📴 收到 SIGTERM 信号，正在关闭 Socket 服务器...');
  httpServer.close(() => {
    console.log('✅ Socket 服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n📴 收到 SIGINT 信号（Ctrl+C），正在关闭 Socket 服务器...');
  httpServer.close(() => {
    console.log('✅ Socket 服务器已关闭');
    process.exit(0);
  });
});
