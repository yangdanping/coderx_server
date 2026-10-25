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

Node.js、Koa 3、PostgreSQL、Socket.IO、Redis、Tiptap JSON、S3/R2 和 Ollama/OpenAI 兼容模型。

## 快速开始

### 环境要求

- Node.js 22.22.2（见 `.nvmrc`）；也支持 24.15+ 或 26+，完整范围见 `package.json#engines`
- pnpm 12.11.2（见 `package.json#packageManager`）
- PostgreSQL 15+
- FFmpeg（视频元数据和封面处理需要 `ffmpeg`、`ffprobe` 在服务进程的 PATH 中）
- Ollama（可选，仅 AI 功能需要）
- Redis（可选，仅 Redis presence 或多实例 Socket.IO 广播需要）

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
  node src/app/keys/generate-keys.js
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

## 核心环境变量

| 变量                           | 默认/示例                  | 说明                                   |
| ------------------------------ | -------------------------- | -------------------------------------- |
| `APP_PORT`                     | `8000`                     | Koa HTTP API 端口                      |
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
| `pnpm test`             | 运行服务、任务和控制器测试               |
| `pnpm test:media-db`    | 运行需要 PostgreSQL 的媒体集成测试       |
| `pnpm test:video-media` | 使用真实 FFmpeg 验证短视频和普通视频封面 |
| `pnpm ingest <command>` | 运行内容采集 CLI                         |
| `pnpm media:migrate`    | 运行媒体迁移任务                         |
| `pnpm start`            | 生产模式启动 HTTP API                    |
| `pnpm start:socket`     | 生产模式启动 Socket.IO                   |
| `pnpm start:ingest`     | 生产模式启动内容采集 Worker              |

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
│   ├── router/          # Koa 路由定义
│   ├── service/         # 核心业务与数据库操作
│   ├── socket/          # 在线状态、通知和 Redis Adapter
│   ├── storage/         # 本地与 R2 媒体存储
│   ├── tasks/           # 清理及媒体迁移任务
│   ├── main.js          # HTTP API 入口
│   └── socket_server.js # Socket.IO 入口
├── test/                # 单元、服务和 PostgreSQL 集成测试
└── ecosystem.config.js  # PM2 多进程配置
```

HTTP 请求由 `router` 进入 `controller`，再交给 `service` 完成业务和数据库操作。Socket.IO 独立运行，单实例默认使用内存 presence；多实例部署时可启用 Redis presence 和 Adapter。

## 生产运行

`ecosystem.config.js` 会启动 HTTP、Socket.IO 和单实例内容采集 Worker：

```bash
pm2 start ecosystem.config.js
```

该文件当前使用 `/root/coderx_server` 作为部署目录；部署到其他路径前需调整其中的 `cwd` 和 `env_file`。已运行的实例更新代码后使用 `pm2 restart ecosystem.config.js --update-env`，并核对 `pm2 status`、API 和 Socket 健康。

2026-10-21 的整理已将代码推送到 `main` 并删除旧工作分支；当次生产只读核对仍为 `1eb6d15`，本轮新增修复尚未部署。下一次部署前，确认生产工作区干净，保留该环境的配置、密钥和媒体，执行 `git fetch origin --prune` 后显式切换到 `main`，使用 `git merge --ff-only origin/main`；出现分叉或本地改动应先处理，不能强制覆盖。核对部署目标后用 `CI=true pnpm install --frozen-lockfile` 安装，再重启现有 PM2 服务并记录实际提交。

现有 `just deploy` 依赖当前分支的 `git pull`，不负责从已删除的工作分支切换到 `main`；`just deploy-first-time` 会重建 JWT 密钥，不能用于已有环境。后端也没有 `build`、`build-only`、`type-check` 或 `lint` npm script，相关遗留 just 配方不是有效检查入口；当前命令以本文和 `package.json` 为准。

数据库按[迁移说明](./migrations/README.md)逐项核对；本轮同步未新增业务 DDL，不要重放已应用脚本。

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
- [Hono 迁移评估（当前不实施）](./HONO_MIGRATION.md)

## License

ISC
