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
- **AI 内容供给**：
  - 从公开 RSS/Atom 来源采集摘要与原文链接，不依赖 Koa、登录态或网页全文抓取。
  - 候选先进入独立暂存池，经中文化、人工审批后才允许事务发布。
  - node-cron、PM2 单实例和 PostgreSQL advisory lock 共同避免任务重叠。

## 快速开始

### 1. 环境要求

- Node.js >= 16
- PostgreSQL >= 15（默认）或 MySQL >= 8.0
- Ollama (可选，用于 AI 功能)

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境

复制 `.env.example` 为 `.env.development` 并修改配置：

```env
APP_PORT=8000
# PostgreSQL 连接
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=coderx
PGUSER=postgres
PGPASSWORD=your_password

# 或使用统一连接串
# DATABASE_URL=postgresql://postgres:${PGPASSWORD}@127.0.0.1:5432/coderx

# 可选：当服务部署在反向代理/CDN 后面时，覆盖接口中返回的公开 API 地址
# PUBLIC_API_ORIGIN=https://api.example.com

# 可选：覆盖文章跳转等前端公开地址
# FRONTEND_URL=https://app.example.com
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

## AI 内容采集

这条流水线用于每天补充约 8–10 篇“人工智能”候选内容。它只保存来源摘要、中文导读和原文链接，不复制第三方全文；所有正式文章都必须先经过候选池。

数据流如下：

```text
公开 RSS/Atom → 规范化/评分/去重 → ingest_candidate
                                      ↓
                               Ollama 中文化
                                      ↓
                              人工 approve
                                      ↓
               article + article_tag + article_source（单事务）
```

### 本地首次运行

先配置 PostgreSQL 与可选的 Ollama，然后执行迁移：

```bash
psql -v ON_ERROR_STOP=1 -f migrations/008_create_content_ingest_pipeline.sql
```

常用命令：

```bash
# 回填最近 30 天，每个来源最多 20 条，总共最多暂存 100 条；不会写入 article
pnpm ingest collect --days 30 --limit 100 --per-source-limit 20

# 使用 Ollama 生成中文标题、摘要和推荐理由
pnpm ingest enrich --limit 60

# 查看候选
pnpm ingest list --status enriched,pending --limit 60
pnpm ingest list --status enriched,pending --limit 60 --json
pnpm ingest list --status enriched,pending --limit 60 --json --output data/ingest-batches/ai-backfill.json

# 明确审批候选；不带 --ids 时按分数审批指定数量
pnpm ingest approve --ids 31,32 --limit 2

# 仅发布已 approved 的候选；作者和标签必须已存在
pnpm ingest publish --limit 10
```

`run` 组合命令会执行 collect 和 enrich。只有显式设置 `INGEST_AUTO_PUBLISH=true` 时，它才会继续尝试发布已经 approved 的候选；默认值为 `false`。

日常采集默认采用各来源的 `dailyLimit`（1–2 条），再按总分选出全局前 10 条，避免单个来源占满当天内容。`--per-source-limit` 仅用于首次回填等明确需要放宽来源上限的场景。

### 调度配置

| 变量                     | 默认值                      | 说明                             |
| ------------------------ | --------------------------- | -------------------------------- |
| `INGEST_ENABLED`         | `false`                     | 是否允许定时回调访问网络和数据库 |
| `INGEST_AUTO_PUBLISH`    | `false`                     | `run` 是否发布已审批候选         |
| `INGEST_CRON`            | `15 7 * * *`                | node-cron 表达式                 |
| `INGEST_TIMEZONE`        | `Asia/Shanghai`             | 调度时区                         |
| `INGEST_DAILY_LIMIT`     | `10`                        | 单次默认处理上限                 |
| `INGEST_AUTHOR_NAME`     | 空                          | 正式文章使用的现有用户名         |
| `INGEST_TAG_NAME`        | `人工智能`                  | 正式文章标签                     |
| `INGEST_OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI 兼容的 Ollama 地址        |
| `INGEST_OLLAMA_MODEL`    | `qwen2.5:7b`                | 中文化模型                       |

PM2 中的 `coderx_ingest_worker` 固定使用一个 fork 实例。node-cron 设置 `noOverlap`，采集入口再使用 PostgreSQL advisory lock，因此手动任务与定时任务并发时也只会有一个采集过程写库。

### 本地与云服务器策略

本地数据库只用于验证来源质量、去重、中文化和发布事务，不直接同步或覆盖云数据库。通过验收后同步代码与迁移文件，在云端执行同一迁移，并让云端 worker 自己重新采集公开来源：

1. 云端先保持 `INGEST_ENABLED=false`、`INGEST_AUTO_PUBLISH=false`。
2. 执行迁移并启动 `coderx_ingest_worker`，确认进程稳定。
3. 手动运行 collect/enrich/list 做影子验证，确认候选质量和数量。
4. 设置 `INGEST_ENABLED=true` 进入定时采集；仍保持自动发布关闭。
5. 只有审批流程稳定后，才评估是否启用自动发布。

候选的 canonical URL、来源 external ID 和内容哈希都有唯一约束；重复运行或云端重新采集不会重复入库。生产数据库迁移和 PM2 启用应作为单独的部署步骤执行。

## License

ISC
