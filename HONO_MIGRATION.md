# Hono 迁移收尾交接

截至 2026-11-25 晚，Task 0–11 与 12A 已完成。正式业务 HTTP 已于当天 15:56 切到 Hono，Task 12B 还差生产业务验收，12C 尚未执行。当前没有已知需要修改的后端业务代码。[各阶段验收记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md)

接手时先在这个后端仓库核对分支、工作区和远程分支，再核对公网 `https://api.ydp321.asia/health/live` 的 `buildId`、源站就绪状态和清理调度归属。11 月 25 日的生产 SHA 为 `ab0d2b55d665e614d4c1a57340ea65e48f42cd3e`。Hono 与旧 Koa 分属两个 PM2 实例。[AWS 进程与回滚手册](deploy/README.md#生产运行状态2026-11-25)

## 下一会话的三项收尾

### 1. 正式业务验收（12B）

用维护者同意的测试账号和内容执行。保留现有私人草稿，另建测试内容。

- [ ] Google 和 GitHub 分别完成登录，回到正式站后确认账号身份。
- [ ] 发布测试图片，核对归档后的媒体回读。上传短视频，确认转码完成、封面可读、浏览器可播放、Range 请求返回 206。用新旧 HTTP 各读取同一份测试数据和媒体，验证仍能回滚。
- [ ] 用两个账号产生一次通知，确认接收方实际收到对应的实时事件。
- [ ] 记录时间、构建号及业务结果。用访问日志观察 5xx、用有耗时数据的样本核对 P95，同时复核数据库连接、CPU、内存、媒体处理和 AI 流。样本不足的项目注明观察范围。

### 2. 后端仓库归档

11 月 25 日晚，本地分支为 `codex/hono-typescript-migration`，后端远程 `yangdanping/coderx_server` 只列出 `main`（`28a693d`）。

- [ ] 审查后端迁移和文档差异，将迁移分支推送到后端远程，并按维护者确定的方式合入主分支。
- [ ] 更新远程引用，验证远程主分支包含这次上线的版本和交接文档。保留提交历史的合并可用 `git merge-base --is-ancestor ab0d2b55d665e614d4c1a57340ea65e48f42cd3e origin/main` 核对。前端 Vercel 发布单独记录。

### 3. 清理任务交接与旧 HTTP 退役（12C）

- [ ] 业务验收通过后，记录旧 Koa 的恢复命令并核对回滚材料。确认旧请求、上传、AI 流、FFmpeg 和清理作业已排空，再在维护窗口停旧 Koa 及其调度。
- [ ] 从 Hono release 用 `CLEANUP_WORKER_ENABLED=true` 启用一个独立清理 Worker（入口 `dist/tasks/cleanup.worker.js`）。Hono HTTP 保持 `BACKGROUND_JOBS_ENABLED=false`。核对实际调度、重启恢复配置、Socket 和采集状态。
- [ ] 留下清理 Worker 的恢复方法，保留共享媒体、配置、旧 release 及其依赖。确认稳定后盘点本次隔离测试资源。[切流与回滚记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#2026-11-25-12b-正式切流与首轮观察)

每完成一项，在本页更新状态，并把日期、验证结果及仍需维护者参与的操作写入[验收记录](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#生产验收与剩余事项)。
