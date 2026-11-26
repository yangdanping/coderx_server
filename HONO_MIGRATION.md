# Hono 迁移收尾交接

Task 0–11 与 12A 已完成。正式 HTTP 于 2026-11-25 15:56 切到 Hono。11 月 26 日已验证 Google 登录、媒体发布与播放、新旧 HTTP 兼容和双账号实时通知。GitHub 回调登记已修正，12B 剩余 GitHub 登录复测，12C 待生产维护窗口。[各阶段验收记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md)

11 月 26 日复核公网 `/health/live`、源站 `/health/ready` 和 release 的 `BUILD_SHA`，均为 `ab0d2b55d665e614d4c1a57340ea65e48f42cd3e`。Hono HTTP 关闭定时清理，旧 Koa 仍是唯一的清理调度执行方。Socket.IO 和采集独立在线。[AWS 进程与回滚手册](deploy/README.md#生产运行状态2026-11-25)

## 下一会话的三项收尾

### 1. 正式业务验收（12B）

用维护者同意的测试账号和内容执行。保留现有私人草稿，另建测试内容。

- [x] Google 登录后回到正式站，维护者确认账号身份。
- [x] GitHub `coderx` OAuth App 的回调域名拼写已由维护者修正，登记值为 `https://api.ydp321.asia/oauth/github/callback`。
- [ ] 从正式站重新完成 GitHub 登录，回站后确认账号身份。
- [x] 用独立测试账号发布文章 `182` 和合成媒体。R2 原图、视频封面及视频可读，Chrome 播放短片至 `0:02`。Hono 和 Koa 返回相同的正文、媒体 URL 和本地媒体字节，视频 Range 均为 206。
- [x] 测试账号 `15` 点赞账号 `14` 的测试文章，接收方收到一次匹配的 `notification:new`。
- [x] 记录版本、API 访问日志的 5xx、验收样本的 P95，以及数据库连接、CPU、内存、媒体处理和真实 AI 流的观察结果。

### 2. 后端仓库归档

11 月 26 日已推送 `codex/hono-typescript-migration`。[PR #4](https://github.com/yangdanping/coderx_server/pull/4) 按维护者选定的方式创建了合并提交 `66660c94405dfca63b3a1f6e0c6e0343f7ac2986`。

- [x] 将后端迁移分支推送到远程，类型检查、构建及 888 项本地回归通过。
- [x] 完成合并前复核，通过合并提交合入 `main`。
- [x] 重新抓取 `origin/main`，验证上线版本 `ab0d2b5` 和验收文档提交 `90693a3` 均为其祖先提交。前端 Vercel 发布单独记录。

### 3. 清理任务交接与旧 HTTP 退役（12C）

- [ ] 业务验收通过后，记录旧 Koa 的恢复命令并核对回滚材料。确认旧请求、上传、AI 流、FFmpeg 和清理作业已排空，再在维护窗口停旧 Koa 及其调度。
- [ ] 从 Hono release 用 `CLEANUP_WORKER_ENABLED=true` 启用一个独立清理 Worker（入口 `dist/tasks/cleanup.worker.js`）。Hono HTTP 保持 `BACKGROUND_JOBS_ENABLED=false`。核对实际调度、重启恢复配置、Socket 和采集状态。
- [ ] 留下清理 Worker 的恢复方法，保留共享媒体、配置、旧 release 及其依赖。确认稳定后盘点本次隔离测试资源。[切流与回滚记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#2026-11-25-12b-正式切流与首轮观察)

每完成一项，在本页更新状态，并把日期、验证结果及仍需维护者参与的操作写入[验收记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#生产验收与剩余事项)。
