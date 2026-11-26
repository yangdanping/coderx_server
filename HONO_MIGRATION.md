# Hono 迁移收尾交接

Task 0–11、12A、12B 和 12C 均已完成。正式 HTTP 于 2026-11-25 15:56 切到 Hono。11 月 26 日通过生产业务验收，旧 Koa 于 15:11:15 退出，清理由独立 Worker 接手。[各阶段验收记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md)

公网 `/health/live`、源站 `/health/ready` 和 release 的 `BUILD_SHA` 均为 `ab0d2b55d665e614d4c1a57340ea65e48f42cd3e`。Hono HTTP 的定时清理关闭，唯一清理调度执行方为 `coderx-hono-cleanup.service`。Socket.IO 和采集独立在线。[AWS 进程与回滚手册](deploy/README.md#生产运行状态2026-11-26)

## 三项收尾结果

### 1. 正式业务验收（12B）

用维护者同意的测试账号和内容执行。保留现有私人草稿，另建测试内容。

- [x] Google 登录后回到正式站，维护者确认账号身份。
- [x] GitHub `coderx` OAuth App 的回调域名拼写已由维护者修正，登记值为 `https://api.ydp321.asia/oauth/github/callback`。
- [x] GitHub 回调登记修正后，维护者从正式站重新登录成功。正式 API 于 15:06:48 收到回调并返回 302。
- [x] 用独立测试账号发布文章 `182` 和合成媒体。R2 原图、视频封面及视频可读，Chrome 播放短片至 `0:02`。Hono 和 Koa 返回相同的正文、媒体 URL 和本地媒体字节，视频 Range 均为 206。
- [x] 测试账号 `15` 点赞账号 `14` 的测试文章，接收方收到一次匹配的 `notification:new`。
- [x] 记录版本、API 访问日志的 5xx、验收样本的 P95，以及数据库连接、CPU、内存、媒体处理和真实 AI 流的观察结果。

### 2. 后端仓库归档

11 月 26 日已推送 `codex/hono-typescript-migration`。[PR #4](https://github.com/yangdanping/coderx_server/pull/4) 按维护者选定的方式创建了合并提交 `66660c94405dfca63b3a1f6e0c6e0343f7ac2986`。

- [x] 将后端迁移分支推送到远程，类型检查、构建及 888 项本地回归通过。
- [x] 完成合并前复核，通过合并提交合入 `main`。
- [x] 重新抓取 `origin/main`，验证上线版本 `ab0d2b5` 和验收文档提交 `90693a3` 均为其祖先提交。前端 Vercel 发布单独记录。

### 3. 清理任务交接与旧 HTTP 退役（12C）

- [x] 在维护窗口内复核旧 HTTP、上传与 AI 流连接、FFmpeg 及清理作业已排空，停止旧 Koa，确认 8000 关闭并从 PM2 主、备开机恢复清单移除。
- [x] 从正式 Hono release 启用 `coderx-hono-cleanup.service`，验证启动扫描、正常退出和再次启动。清理每天北京时间 02:00 调度，HTTP 保持 `BACKGROUND_JOBS_ENABLED=false`。Socket.IO 和采集进程持续在线。
- [x] 保留旧 release、共享媒体、配置、依赖及回滚备份，记录恢复命令并盘点 12A 和 12B 测试资源。[12C 恢复与回滚](deploy/README.md#12c-恢复与回滚)

具体时间、验证结果和测试资源见[验收记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#生产验收与剩余事项)。
