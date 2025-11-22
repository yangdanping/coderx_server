# CoderX Server

## 项目简介

CoderX Server 是 CoderX 论坛项目的后端服务，基于 Koa.js 框架构建。它提供了 RESTful API 和实时通信服务（WebSocket/Socket.IO），支持用户认证、文章管理、评论互动以及 AI 助手等功能。

## 目录结构

```
coderx_server/
├── logs/               # 日志文件
├── public/             # 静态资源（头像、图片等）
├── src/
│   ├── app/            # 应用核心配置 (database, config, error-handle)
│   ├── constants/      # 常量定义
│   ├── controller/     # 控制器层：处理业务逻辑
│   ├── middleware/     # 中间件层：鉴权、日志、文件处理
│   ├── router/         # 路由层：API 接口定义
│   ├── service/        # 服务层：数据库操作与核心业务
│   ├── socket/         # 实时通信逻辑 (Socket.IO & WebSocket)
│   ├── tasks/          # 定时任务
│   ├── utils/          # 工具函数
│   ├── main.js         # HTTP 服务入口
│   └── socket_server.js # Socket 服务入口
└── package.json
```

## 核心功能

- **用户系统**：注册、登录（JWT）、头像上传、个人信息管理。
- **内容管理**：文章发布（支持 Markdown/富文本）、标签管理、文件上传。
- **互动功能**：评论、回复、点赞、收藏。
- **实时通信**：
  - 在线用户状态广播（支持 Socket.IO 和 WebSocket 双协议）。
  - 观察者模式：支持未登录游客查看在线列表。
- **AI 助手**：
  - 基于 Ollama (Qwen2.5/DeepSeek-r1) 的本地/远程 LLM 集成。
  - 支持长文分析与问答（智能 HTML 清洗 + 50k 上下文支持）。
  - 流式响应（Stream）输出。

## 快速开始

### 1. 环境要求

- Node.js >= 16
- MySQL >= 8.0
- Ollama (可选，用于 AI 功能)

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境

复制 `.env.example` 为 `.env` 并修改配置：

```env
APP_PORT=8000
MYSQL_HOST=localhost
MYSQL_DATABASE=coderx
MYSQL_USER=root
MYSQL_PASSWORD=your_password
# ...
```

### 4. 启动服务

```bash
# 开发模式（同时启动 HTTP 和 Socket 服务）
npm run dev

# 仅启动 HTTP 服务
npm run serve

# 仅启动 Socket 服务
npm run socket
```

## License

ISC
