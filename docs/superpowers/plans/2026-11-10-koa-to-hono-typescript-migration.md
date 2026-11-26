# Koa → Hono 迁移验收记录

这里保存各环境实际通过的验证、生产版本和切流依据。后续验收结果按日期追加。当前待办只在[迁移收尾交接](../../../HONO_MIGRATION.md)维护。

完整的 Task 0–11 原始实施计划保存在迁移提交中，可用 `git show ab0d2b5:docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md` 查阅。

## 2026-11-20 Task 11 本地最终验收与交接

- Task 0–9 完成 Koa/JavaScript 到 Hono/严格 TypeScript ESM 的迁移。业务服务和 SQL 沿用原接口，HTTP、Socket.IO、采集及清理具有独立入口。16 个模块的 85 条业务路由、2 个健康端点、324 条冻结响应和 12 个维护开关的执行顺序均已核对。原始对照见[路由清单](../../../test/fixtures/http-contracts.json)和[响应样本](../../../test/fixtures/http-response-contracts.json)。
- Task 10–11 用 pnpm 12.11.2 在 Node 22.22.2、26.13.1 各通过类型检查、构建及 888/888 个回归测试。无源码制品验证了 HTTP、Socket 和采集进程启停，PM2/Nginx 演练验证了就绪、断开与恢复。
- 隔离 PostgreSQL 事务与并发测试 21/21，临时 Redis 验证按账号投递一次，真实 FFmpeg/ffprobe 在两个 Node 版本各通过 2/2。测试使用独立数据库、媒体目录和密钥。此轮 R2、OAuth 及 AI 使用替身。

## Task 12A 隔离验收

2026-11-21 至 11-22，使用提交 `ab0d2b55d665e614d4c1a57340ea65e48f42cd3e`、Linux ARM64 Node 22.22.2 和锁定依赖。镜像内离线回归 888/888。制品 `coderx-ab0d2b55d665e614d4c1a57340ea65e48f42cd3e.tar.gz` 的 SHA-256 为 `99ae9ad8ff87992694d3a34cb8b5c916edbd7a07a69eeec4b25bf5ffe475d3c7`。

| 环境 | 实际通过的操作 |
| --- | --- |
| AWS 隔离库、Redis、媒体目录 | 两个测试账号注册并登录，文章与 Flow 草稿发布、幂等重试，图片上传回读，短视频转码、封面与 Range 206，接收方通过真实 Socket 收到点赞通知 |
| AWS 隔离采集与代理 | 单一 RSS 源生成待审候选。独立 Nginx 经私有转发访问本机模型，验证 AI 流结束和客户端中断 |
| 本机同一制品、测试 OAuth 客户端 | Google 和 GitHub 各完成浏览器回调，签发的 JWT 均通过 `/user/checkauth` |
| 本机同一制品、R2 测试桶 | 文章发布后原图和缩略图均可通过对象接口和开发域名读取，删除测试文章后两对象消失，测试桶计数为零 |

AWS 隔离目录为 `/home/admin/coderx-12a-ab0d2b5.GOiodXlb`，当次结束时四个测试服务均已停止。从本机验证的 Cloudflare R2 测试桶为 `coderx-12a-r2-test`。这些标识供最后盘点临时资源时核对。

## 2026-11-25 12B 正式切流与首轮观察

- AWS 生产制品、专用 Node 和依赖包均已在 `/opt/coderx-hono/artifacts` 校验。Hono 在 `/opt/coderx-hono/releases/ab0d2b55d665e614d4c1a57340ea65e48f42cd3e` 运行，专用 Node 为 `/opt/coderx-hono/runtime/bin/node`。正式 PostgreSQL 18.4 只读事务通过，28 张表、232 个列定义、9 项关键约束及 5 项唯一部分索引与基线相符。
- 北京时间 15:56:46，Nginx 平滑重载。API 域名根路径、源站前端 Host 的 `/api/` 均转发至 Hono，后者剥除前缀。此前已实际验证独立 systemd 服务能恢复 Hono PM2 并启用开机启动。旧 Socket 上游继续监听 8001。前端公网域名的 `/api/` 返回前端 HTML，该入口的代理行为在源站验证。
- 两条源站入口均通过就绪和基础业务探测。公网 API 返回预期构建，标签、文章、Flow、OAuth 授权入口、CDN 图片 Range 206、Socket.IO 握手与 WebSocket 升级 101 均通过。真实 AI 请求收到文本和 `[DONE]`。首轮 12 次探测通过，15:59:48 结束值守。
- 本次回滚资料在 AWS 的 `/opt/coderx-hono/cutover.WXaBUMbZ`，含 `nginx.previous.conf`、切流后配置、`watch.sh` 和 `watch.log`。切流后 `/etc/nginx/nginx.conf` 的 SHA-256 为 `c9b12b31d317a583a0fa6e437257ff2e2a57740a3db28c3cb0dd85c9a95702c6`，切流前为 `f6e60d677a50855e9bacd8d45be6d8c70a362357e72c2a3a38b4883fc772a0bd`。核对旧进程就绪、调度归属和配置摘要后，现场回滚入口为 `sudo -n /bin/bash /opt/coderx-hono/cutover.WXaBUMbZ/watch.sh rollback`。[运行与回滚手册](../../../deploy/README.md)

## 生产验收与剩余事项

- 11 月 25 日 17:25–17:26，维护者在正式站保存图文草稿，刷新后确认正文与图片都恢复。上传、图片回读、草稿保存和回读四类请求均返回 200。这次操作覆盖草稿保存与恢复。
- 22:03，公网 liveness 和源站回环 live/ready 均返回 `ab0d2b5`。Hono PM2 在线、重启计数 0，systemd 服务 active、enabled。旧 Koa、Socket 和采集在线。15:56:46 至 22:04:38 的 API 访问日志有 9 条 1xx、450 条 2xx、36 条 4xx、0 条 5xx。当时的访问日志记录了状态码，未记录请求耗时。

### 2026-11-26 12B 正式业务验证

以下时间为北京时间。公网 `/health/live`、源站 `/health/ready` 和制品 `BUILD_SHA` 均为 `ab0d2b55d665e614d4c1a57340ea65e48f42cd3e`。正式 HTTP 运行于 Hono，定时清理由旧 Koa 执行。

- 14:28，两个独立账号 `14`、`15` 注册、登录并通过 `/user/checkauth`。测试文章 `182` 的正文直接发布，使用合成图片 `572` 和短片 `573`，验收没有调用草稿接口。
- 短片状态从 `processing` 变为 `completed`，FFprobe 记录分辨率 320×180 和 2 秒时长，FFmpeg 从已编码的 MP4 生成 JPEG 封面。发布后通过 R2 CDN 读取原图、缩略图和封面均为 200，视频 `Range: bytes=0-1023` 为 206，`Content-Range: bytes 0-1023/57817`。在正式站文章详情用 Chrome 播放至 `0:02`。
- 从源站分别向 Hono `18080` 和 Koa `8000` 读取同一文章、视频元数据、原图、缩略图、封面和视频分段。结构化正文摘要、归档媒体 URL 和各媒体响应字节一致。两种实现的视频分段均返回 206，归档视频同一分段与本地副本一致。
- 14:28:42，账号 `15` 点赞测试文章，账号 `14` 在正式 Socket.IO WebSocket 上收到一次 `notification:new`。事件 `8` 的类型为 `article_like`，发送方、接收方和文章均与操作匹配。
- 自 25 日 15:56:46 切流至 26 日 14:29:46，现存 API Nginx 访问日志记录 24 条 1xx、644 条 2xx、44 条 4xx、0 条 5xx。Hono 应用日志从切流至 26 日 14:30:49 有 618 条处理耗时样本，整体最近秩 P95 为 263 毫秒，GET 为 506 毫秒（459 条），POST 为 2691 毫秒（20 条）。应用计时截止到响应对象生成。另取 15 条客户端计时的业务验收请求，均为 HTTP 200，中位数 774 毫秒，P95 为 3471 毫秒，最慢为视频关联与归档。
- 源站负载快照为 0.00，`vmstat` 两个实时采样 CPU 空闲 100%，可用内存约 675 MiB，Hono HTTP 主进程 RSS 约 250 MiB。数据库连接上限 100，空闲时的只读快照仅见采样会话 1 条，未见其他活跃查询。媒体状态查询未见待处理或正在处理的视频。
- 公网 `/ai/chat` 用合成提示返回 HTTP 200 和 `text/event-stream`，首包约 1.77 秒，约 10.56 秒收到文本及 `[DONE]`。
- OAuth 状态接口显示 Google 和 GitHub 均启用。两种正式登录等待维护者在正式站完成回调并核对身份。

### 2026-11-26 后端归档进度

- 本地 Node 26.13.1 下通过类型检查、构建和 888 项回归测试。迁移分支已推送，维护者已确认通过 [PR #4](https://github.com/yangdanping/coderx_server/pull/4) 创建合并提交。
- 单独核对前端 `coderx.my` 对应的 Vercel production 部署 `dpl_GRoLBYNkYWrr5eTfDLQXM1xqnWP7`，状态 Ready，创建于 11 月 25 日 17:53:41。

### 2026-11-26 12C 只读准备

- Hono、旧 Koa、Socket.IO、采集均在线。Hono HTTP 的 `BACKGROUND_JOBS_ENABLED=false`。旧 Koa 的调度记录显示 26 日 02:00 的图片和视频清理检查均结束，PM2 中尚无独立清理 Worker，媒体清理队列为 0。
- AWS 切流及回滚 Nginx 配置 SHA-256 与 25 日记录一致。旧 Koa release `1eb6d156392255094988fd51a12b1b4fd9f02276` 的工作目录、启动配置、依赖和回环读请求均已核对。
- root PM2 开机恢复清单当前包含旧 Koa、Socket 和采集。12C 将先保存回滚材料，再从正常清单及备用清单移除旧 Koa，保留另外两个进程。独立 Worker 需显式使用现有共享媒体根目录和独立日志目录。

## 2026-11-25 本机开发数据库

Docker Desktop 的现用容器为 `pg`。移除已停止的升级前容器 `pg-before-upgrade-20261027-174349` 前后，Hono 的 `/health/ready` 和 `GET /tag?limit=1` 均返回 200，标签查询业务码为 0，应用数据库适配器成功提交只读事务。新旧容器挂载不同的数据卷。旧容器的三个卷已保留，其中旧 PostgreSQL 数据卷为 `5294c7d87cbddedfd61a5eb80c19738ed55381a4c16011ebd9e518678244c0df`。
