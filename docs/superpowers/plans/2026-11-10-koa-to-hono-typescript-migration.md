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
- 正式 OAuth 完整回调、视频发布和播放、接收方通知等验收结果，接手后记录到本节，并同步[三项收尾清单](../../../HONO_MIGRATION.md#下一会话的三项收尾)。

## 2026-11-25 本机开发数据库

Docker Desktop 的现用容器为 `pg`。移除已停止的升级前容器 `pg-before-upgrade-20261027-174349` 前后，Hono 的 `/health/ready` 和 `GET /tag?limit=1` 均返回 200，标签查询业务码为 0，应用数据库适配器成功提交只读事务。新旧容器挂载不同的数据卷。旧容器的三个卷已保留，其中旧 PostgreSQL 数据卷为 `5294c7d87cbddedfd61a5eb80c19738ed55381a4c16011ebd9e518678244c0df`。
