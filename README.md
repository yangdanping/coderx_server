# CoderX Server

CoderX Server 是 CoderX 内容社区的后端服务，提供用户认证、文章与 Flow 内容、互动通知、媒体管理、AI 助手和内容采集能力。

- 前端仓库：[yangdanping/coderx](https://github.com/yangdanping/coderx)
- 文档入口：[当前指南与历史资料](./docs/README.md)
- 在线站点：[https://coderx.my](https://coderx.my)

## 主要能力

- JWT 登录、Google/GitHub OAuth、用户资料与头像
- 文章、标签、草稿、评论、回复、点赞和收藏
- Flow 图文动态，以及文章图片/视频媒体管理（Flow 当前仅支持图片）
- Socket.IO 在线状态和实时通知，可选 Redis 跨实例广播
- OpenAI 兼容接口的 AI 问答与写作补全，默认模型为 `qwen2.5:7b`
- RSS/Atom 内容候选采集、人工审批和发布

## 技术栈

Node.js、Hono、TypeScript 7（ESM）、PostgreSQL、Socket.IO、Redis、Tiptap JSON、S3/R2 和 Ollama/OpenAI 兼容模型。

## 快速开始

### 环境要求

- Node.js 22.22.2（见 `.nvmrc`）；也支持 24.15+ 或 26+，完整范围见 `package.json#engines`
- pnpm 12.11.2（见 `package.json#packageManager`）
- PostgreSQL 15+
- FFmpeg（视频元数据和封面处理需要 `ffmpeg`、`ffprobe` 在服务进程的 PATH 中）
- Ollama（可选，仅 AI 功能需要）
- Redis（Socket.IO 通知订阅需要。也可用于在线状态和多实例广播）

### 1. 安装依赖

```bash
git clone https://github.com/yangdanping/coderx_server.git
cd coderx_server
nvm install
nvm use
pnpm --version # 应为 12.11.2
pnpm install --frozen-lockfile
```

### 2. 配置环境变量

```bash
test -e .env.development || cp .env.example .env.development
```

已有配置时直接核对，不覆盖原文件。至少配置 PostgreSQL 连接。开发环境默认使用 `.env.development`，生产环境使用 `.env.production`；完整变量及安全默认值见 [.env.example](./.env.example)。

### 3. 准备数据库

`migrations/` 只保存现有基础 Schema 之上的增量迁移，不是完整的数据库初始化脚本。全新环境需要先恢复 CoderX 基础 Schema，核对历史前置脚本和目标库结构，再按依赖顺序执行尚未应用的迁移；文件编号不代表已应用状态，也不保证可重复执行。具体见 [数据库迁移说明](./migrations/README.md)。

### 4. 生成 JWT 密钥

仅在首次安装且该环境没有现有密钥时执行；生成脚本会覆盖同名文件：

```bash
if [ ! -e src/app/keys/private.key ] && [ ! -e src/app/keys/public.key ]; then
  pnpm exec tsx src/app/keys/generate-keys.ts
fi
```

如果只缺其中一个文件，应先恢复该环境的匹配密钥对。生成的 `private.key` 和 `public.key` 不得提交到 Git。轮换和生产部署注意事项见 [JWT 密钥管理](./src/app/keys/README.md)。

### 5. 启动服务

HTTP API 和 Socket.IO 是两个独立进程，需要分别启动：

```bash
# 终端 1：http://127.0.0.1:8000
pnpm dev

# 终端 2：http://127.0.0.1:8001
pnpm dev:socket
```

验证 Socket.IO 进程：

```bash
curl http://127.0.0.1:8001/health
```

预期返回 `{"status":"ok","service":"socket-server"}`。

### 独立媒体清理 Worker

`pnpm dev:cleanup` 运行源码入口，`pnpm start:cleanup` 运行编译后的入口。Worker 默认关闭，仅在其进程配置中显式设置 `CLEANUP_WORKER_ENABLED=true` 后启动。旧发布版的 Koa 进程仍可能负责清理。切换时先停止旧调度并等待在途任务退出，保持 Hono 的 `BACKGROUND_JOBS_ENABLED=false`，再启用独立 Worker。

## 核心环境变量

| 变量                           | 默认/示例                  | 说明                                   |
| ------------------------------ | -------------------------- | -------------------------------------- |
| `APP_PORT`                     | `8000`                     | Hono HTTP API 端口                      |
| `PUBLIC_API_ORIGIN`            | `http://127.0.0.1:8000`    | 返回给客户端的公开 API 地址            |
| `FRONTEND_URL`                 | `http://127.0.0.1:5173`    | OAuth 回跳和 CORS 使用的前端地址       |
| `DATABASE_URL`                 | 留空                       | PostgreSQL 连接串；也可改用 `PG*` 变量 |
| `SOCKET_PORT`                  | `8001`                     | 独立 Socket.IO 服务端口                |
| `PRESENCE_STORE`               | `memory`                   | 在线状态存储，可选 `memory` 或 `redis` |
| `SOCKET_REDIS_ADAPTER_ENABLED` | `false`                    | 是否启用跨 Socket.IO 实例广播          |
| `REDIS_URL`                    | `redis://127.0.0.1:6379/0` | Redis 连接地址                         |
| `OLLAMA_HOST`                  | `http://127.0.0.1`         | 模型主机，带协议但不带端口或 `/v1`     |
| `OLLAMA_PORT`                  | `11434`                    | 模型服务端口                           |
| `AI_ALLOWED_MODELS`            | `qwen2.5:7b`               | Web AI 模型白名单，模型需已安装        |

Google OAuth、R2 媒体存储和内容采集均为可选功能。媒体默认使用本地模式；`INGEST_ENABLED=false` 只禁用定时采集，不阻止显式 CLI 操作。AI 采集的模型地址使用独立的 `INGEST_OLLAMA_BASE_URL`。

## AI 连通与恢复

后端代表浏览器访问 Ollama。远程 Windows 设备通过 Tailscale 连接时，`OLLAMA_HOST` 填 `http://<Windows 的 Tailscale IP>`，端口单独设为 `OLLAMA_PORT=11434`；重启 API 后检查：

```bash
curl -f http://127.0.0.1:8000/ai/health
```

应返回 `status: "online"` 和非空模型列表。离线时先检查两端 Tailscale 登录与在线状态，再核对 Ollama 的监听地址、端口可达性和模型白名单。网络恢复后前端可点击“重新检查”；失败、停止或响应截断后的问题可编辑重试。采集服务另用 `INGEST_OLLAMA_BASE_URL`，见[采集说明](./CONTENT_INGEST.md)。

## 常用命令

| 命令                    | 用途                                     |
| ----------------------- | ---------------------------------------- |
| `pnpm dev`              | 开发模式启动 HTTP API                    |
| `pnpm dev:socket`       | 开发模式启动 Socket.IO                   |
| `pnpm test`             | 清理构建并运行服务、任务、控制器和 HTTP 测试 |
| `pnpm test:media-db`    | 运行需要 PostgreSQL 的媒体集成测试       |
| `pnpm test:video-media` | 使用真实 FFmpeg 验证短视频和普通视频封面 |
| `pnpm ingest <command>` | 运行内容采集 CLI                         |
| `pnpm media:migrate`    | 运行媒体迁移任务                         |
| `pnpm start`            | 生产模式启动 HTTP API                    |
| `pnpm start:socket`     | 生产模式启动 Socket.IO                   |
| `pnpm start:ingest`     | 生产模式启动内容采集 Worker              |

生产启动脚本和 CLI 从 `dist` 运行，先执行 `pnpm build`。其中 `pnpm dev` 和 `pnpm dev:socket` 直接运行源码。

`pnpm type-check` 检查所有业务源码、HTTP 和控制器测试，以及原有的 TypeScript 任务与集成测试。原 JavaScript 测试迁移为 ESM 后，继续通过运行测试核对动态替身和结果。

`pnpm test:video-media` 需要本机已安装 FFmpeg，使用临时文件验证 0.2 秒和 3 秒视频能生成封面，结束后自动清理；不会向数据库写入。

`pnpm test` 不包含 PostgreSQL 集成测试。`test:media-db` 中部分测试会修改应用表，只能连接专用的可丢弃测试数据库，并使用临时 JWT 密钥、本地测试媒体；不要连接开发或生产业务库。

## 项目结构

```text
coderx_server/
├── migrations/          # PostgreSQL 增量迁移
├── public/              # 本地头像、图片和视频
├── src/
│   ├── app/             # 环境、数据库、日志和 JWT 配置
│   ├── constants/       # 跨模块常量
│   ├── controller/      # HTTP 输入校验与响应编排
│   ├── errors/          # 业务错误类型
│   ├── ingest/          # 内容采集 CLI、Worker 和流水线
│   ├── middleware/      # 鉴权、错误处理、日志和上传中间件
│   ├── router/          # Hono 路由定义
│   ├── service/         # 核心业务与数据库操作
│   ├── socket/          # 在线状态、通知和 Redis Adapter
│   ├── storage/         # 本地与 R2 媒体存储
│   ├── tasks/           # 清理及媒体迁移任务
│   ├── main.ts          # HTTP API 源码入口
│   └── socket_server.ts # Socket.IO 入口
├── test/                # 单元、服务和 PostgreSQL 集成测试
└── ecosystem.config.cjs  # PM2 多进程配置
```

HTTP 请求由 `router` 进入 `controller`，再交给 `service` 完成业务和数据库操作。Socket.IO 独立运行，单实例默认使用内存 presence；多实例部署时可启用 Redis presence 和 Adapter。

## 生产运行

`ecosystem.config.cjs` 记录 HTTP、Socket.IO 和单实例内容采集 Worker 的 PM2 进程布局。部署前先构建，独立发布目录使用 `dist`、运行时依赖与明确的环境文件、媒体目录和 JWT 密钥路径。

独立 Hono 候选使用 `deploy/ecosystem.hono.config.cjs`、`deploy/nginx.hono.example` 和 `just deploy-hono`。制品构建、环境取值、就绪检查、启停恢复及切流回滚见[候选发布手册](./deploy/README.md)。生产操作按[迁移计划](./docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md)单独授权。已有环境的 JWT 密钥由原环境配置提供。

数据库按[迁移说明](./migrations/README.md)逐项核对；本轮同步未新增业务 DDL，不要重放已应用脚本。

Hono 迁移已完成本地最终验收。Node 22.22.2 和 26.13.1 均通过完整回归与无源码制品验证。数据库、通知和视频处理的隔离实测，以及目标环境待验项目，见[本地验收记录](./docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#2026-11-20-task-11-本地最终验收与交接)。

## 常见问题

### 启动时报 JWT 密钥文件不存在

先确认当前运行目录和密钥挂载。已有环境恢复匹配密钥对；首次安装按上文生成。不要用重新生成来处理单个文件缺失，具体见 [JWT 密钥管理](./src/app/keys/README.md)。

### 数据库连接失败

检查 `.env.development` 中的 `DATABASE_URL`，或 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`。本项目不支持 MySQL。

### 实时通知仅在部分实例生效

多实例环境需设置 `PRESENCE_STORE=redis`、`SOCKET_REDIS_ADAPTER_ENABLED=true` 和可访问的 `REDIS_URL`；单实例开发环境保持默认值即可。

## 进一步文档

- [文档导航与历史记录](./docs/README.md)
- [Flow 发布协议及验收边界](./FLOW_PUBLICATION.md)
- [存量媒体迁移 CLI](./docs/media-migration.md)
- [数据库迁移](./migrations/README.md)
- [JWT 密钥管理](./src/app/keys/README.md)
- [AI 内容采集与回填](./CONTENT_INGEST.md)
- [Hono 迁移决定与历史评估](./HONO_MIGRATION.md)

## License

ISC
