# Hono HTTP 发布与回滚手册

## 生产运行状态（2026-11-26）

AWS 上的 `coderx_hono_candidate` 使用独立 release 的 `dist/main.js`，在 `127.0.0.1:18080` 承接两个 Nginx 入口的正式 HTTP。独立 PM2 的 `PM2_HOME` 为 `/opt/coderx-hono/pm2`，由已启用开机启动的 `coderx-hono-candidate.service` 管理。公网 `/health/live` 返回版本号，源站回环 `/health/ready` 检查数据库就绪。

旧 Koa 已停止，8000 已关闭。Socket.IO 从正式 TypeScript release 在 8001 独立运行。root PM2 的主、备开机清单仅保存采集进程。独立的 `coderx-hono-cleanup.service` 执行定时清理。旧 release、正式媒体、环境文件、JWT 密钥和依赖仍在 `/root/coderx_server`，供采集、共享配置和回滚使用。[12C 操作记录](../docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#2026-11-26-12c-清理交接与旧-http-退役)

维护者可在 AWS 上用以下只读命令核对正在服务的版本与进程。检查 Hono 的 PM2 列表前，先确认 systemd 服务处于 active 状态。

```sh
systemctl is-active coderx-hono-candidate.service
curl -fsS http://127.0.0.1:18080/health/ready
sudo -n env PM2_HOME=/opt/coderx-hono/pm2 /opt/coderx-hono/runtime/bin/node /usr/local/bin/pm2 ls
systemctl is-active coderx-hono-cleanup.service
systemctl is-enabled coderx-hono-cleanup.service
```

### 12C 恢复与回滚

旧 Koa 用原目录的 `/root/coderx_server/ecosystem.config.js` 恢复。12C 备份目录 `/opt/coderx-hono/cleanup-handoff.QZHG0qxl` 保存交接前的 PM2 主、备清单、旧 Koa 启动配置、Worker 单元和现场记录。Hono HTTP 的 `BACKGROUND_JOBS_ENABLED` 保持 `false`。

独立清理 Worker 使用 `coderx-hono-cleanup.service` 管理，入口为正式 Hono release 的 `dist/tasks/cleanup.worker.js`。配置显式引用 `/root/coderx_server/.env.production`、共享媒体根目录 `/root/coderx_server/public` 和日志目录 `/var/log/coderx-hono-cleanup`，并设置 `CLEANUP_WORKER_ENABLED=true`。启用后，检查服务状态和下一次调度时间。清理按北京时间每天 02:00 调度，启动时先处理持久化的本地媒体清理队列。

若 12C 后需恢复旧 Koa，先停用独立 Worker，确认其干净退出，再从原目录仅恢复旧 HTTP 进程及其调度。两次 `pm2 save` 将已恢复的进程定义同时写入正常清单及备用清单。

```sh
(
  set -eu
  worker=coderx-hono-cleanup.service
  sudo -n systemctl disable --now "$worker"
  test "$(sudo -n systemctl show "$worker" -p ActiveState --value)" = inactive
  test "$(sudo -n systemctl show "$worker" -p MainPID --value)" = 0
  test "$(sudo -n systemctl show "$worker" -p Result --value)" = success
  test "$(sudo -n systemctl show "$worker" -p ExecMainStatus --value)" = 0
  sudo -n env PM2_HOME=/root/.pm2 /usr/local/bin/pm2 start /root/coderx_server/ecosystem.config.js --only coderx_koa_server
  response=$(curl -fsS --retry 5 --retry-connrefused --retry-delay 1 --max-time 5 'http://127.0.0.1:8000/tag?limit=1')
  printf '%s' "$response" | sudo -n /opt/coderx-hono/runtime/bin/node -e 'if (JSON.parse(require("node:fs").readFileSync(0)).code !== 0) process.exit(1)'
  sudo -n env PM2_HOME=/root/.pm2 /usr/local/bin/pm2 save
  sudo -n env PM2_HOME=/root/.pm2 /usr/local/bin/pm2 save
)
```

核对旧 Koa 已恢复唯一清理调度。需要回切正式 HTTP 时，再执行 Nginx 回滚。

```sh
sudo -n /bin/bash /opt/coderx-hono/cutover.WXaBUMbZ/watch.sh rollback
```

若只恢复独立 Worker，先确认旧 Koa 已停止且不在开机恢复清单，随后运行 `sudo -n systemctl enable --now coderx-hono-cleanup.service`。以清单中的生产状态为准。[迁移收尾交接](../HONO_MIGRATION.md)

## 制作和展开制品

发布记录给出经审查的完整 Git SHA。在构建机选择目标 Node 版本和操作系统/架构，按 `.nvmrc` 与 `package.json` 核对 Node 和 pnpm。以下命令从 Git 提取指定提交到新目录，适用于包含本发布材料的已提交版本。

```bash
set -eu
: "${RELEASE_SHA:?Set the approved full Git SHA}"
commit=$(git rev-parse --verify "$RELEASE_SHA^{commit}")
test "$commit" = "$RELEASE_SHA"
stage=$(mktemp -d)
git archive --format=tar --output="$stage/source.tar" "$commit"
mkdir "$stage/build"
tar -xf "$stage/source.tar" -C "$stage/build"
artifact="$stage/coderx-$commit.tar.gz"
(
  cd "$stage/build"
  CI=true pnpm install --frozen-lockfile
  pnpm type-check
  pnpm build
  printf '%s\n' "$commit" > BUILD_SHA
  COPYFILE_DISABLE=1 tar -czf "$artifact" dist deploy package.json pnpm-lock.yaml pnpm-workspace.yaml patches justfile BUILD_SHA
)
(cd "$stage" && shasum -a 256 "coderx-$commit.tar.gz" > "coderx-$commit.tar.gz.sha256")
```

从批准的制品来源取得压缩包，从发布记录取得预期 SHA-256。在制品目录验证，使用新 release 的绝对路径。运行时依赖在该 release 独立安装，JWT、环境文件和业务媒体由目标环境挂载。

```bash
set -eu
: "${RELEASE_SHA:?Set the approved full Git SHA}"
: "${ARTIFACT_SHA256:?Set the expected SHA-256 from the release record}"
: "${CODERX_HONO_RELEASE_DIR:?Set a new absolute release path}"
case "$CODERX_HONO_RELEASE_DIR" in /*) ;; *) exit 1 ;; esac
archive="coderx-$RELEASE_SHA.tar.gz"
printf '%s  %s\n' "$ARTIFACT_SHA256" "$archive" | shasum -a 256 -c -
mkdir "$CODERX_HONO_RELEASE_DIR"
tar -xzf "$archive" -C "$CODERX_HONO_RELEASE_DIR"
(
  cd "$CODERX_HONO_RELEASE_DIR"
  test "$(cat BUILD_SHA)" = "$RELEASE_SHA"
  CI=true pnpm install --prod --frozen-lockfile
  test -f dist/main.js
)
```

保留上一 release、其运行时依赖和配置引用。旧 Koa 从原 release 恢复。生产更新使用独立 release，以免覆盖仍被采集和回滚使用的 `/root/coderx_server`。

## Socket.IO 发布与回滚

`deploy/coderx-socket@.service` 直接运行指定 release 的 `dist/socket_server.js`。实例名使用完整 Git SHA。单元用现有环境文件中的 Redis 实例、前缀、presence 和 adapter 设置，并显式引用共享 JWT 公钥。Nginx 的两个 `/socket.io/` 入口继续指向 8001。

首切前验证目标 release 包含 `BUILD_SHA` 和 Socket 入口，确认 Redis、JWT、环境文件、当前监听和旧 PM2 恢复配置。使用隔离数据库、Redis 与临时 JWT 做轮询、WebSocket、鉴权、定向通知和启停演练。用 `sudo -n install -m 0644 deploy/coderx-socket@.service /etc/systemd/system/coderx-socket@.service` 安装已通过 `systemd-analyze verify` 的单元，再执行 `sudo -n systemctl daemon-reload`。这一阶段只安装单元。

在生产窗口复核现有连接并保存 root PM2 主、备清单。8001 更换进程时，已有实时连接会重新建立。停止旧 Socket，确认端口释放后，执行 `sudo -n systemctl start "$socket_unit"`。直连 `/health` 通过后，执行 `sudo -n nginx -t` 和 `sudo -n systemctl reload nginx.service`，平滑重载当前配置，清除切换间隙的上游失败状态。[Nginx 重载说明](https://nginx.org/en/docs/control.html)

验证两条代理入口、正式站认证连接和双账号通知。从 root PM2 主、备清单移除旧 Socket，确认采集仍在线，再执行 `sudo -n systemctl enable "$socket_unit"`。11 月 26 日的旧 PM2 清单、Socket 单元及交接日志位于 `/opt/coderx-hono/socket-handoff.uSoelJXy`。

```sh
release_sha=ab0d2b55d665e614d4c1a57340ea65e48f42cd3e
socket_unit="coderx-socket@$release_sha.service"
systemctl is-active "$socket_unit"
systemctl is-enabled "$socket_unit"
curl -fsS --max-time 5 http://127.0.0.1:8001/health
```

若需恢复旧 Socket，停用新单元并确认 8001 已释放。只从旧 release 恢复 Socket，再执行源站探测并更新 PM2 主、备恢复清单。

```sh
(
  set -eu
  release_sha=ab0d2b55d665e614d4c1a57340ea65e48f42cd3e
  socket_unit="coderx-socket@$release_sha.service"
  sudo -n systemctl disable --now "$socket_unit"
  test "$(systemctl show "$socket_unit" -p MainPID --value)" = 0
  test -z "$(ss -Hln 'sport = :8001')"
  sudo -n env PM2_HOME=/root/.pm2 /usr/local/bin/pm2 start /root/coderx_server/ecosystem.config.js --only coderx_socket_server
  curl -fsS --retry 5 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:8001/health
  sudo -n nginx -t
  sudo -n systemctl reload nginx.service
  curl -fsS --retry 3 --retry-delay 1 --max-time 5 -H 'Host: api.ydp321.asia' 'http://127.0.0.1/socket.io/?EIO=4&transport=polling'
  sudo -n env PM2_HOME=/root/.pm2 /usr/local/bin/pm2 save
  sudo -n env PM2_HOME=/root/.pm2 /usr/local/bin/pm2 save
)
```

## 取值与隔离

`APP_ENV_FILE` 指向由环境管理者提供的绝对文件路径。用干净的发布 shell，仅导出本次有意覆盖的变量。应用读取 dotenv 时优先使用已有的进程环境。用专用 PM2 用户或显式 `PM2_HOME` 指向预定候选守护进程。以下表格给出取值依据，记录只保存配置版本与引用。

| 配置 | 本地演练或线上隔离验证 | 生产候选 |
| --- | --- | --- |
| `CODERX_HONO_RELEASE_DIR`、`APP_PORT`、`APP_ENV_FILE` | 新建目录、可用 loopback 端口、演练专用配置 | 取自目标机发布目录约定、监听核对与密钥管理系统，端口与当前 API/Socket 分开 |
| PG | 新建可丢弃的数据库，`DATABASE_URL` 或完整 `PG*`；业务验证使用测试基准 Schema | 经授权且已验证兼容的正式连接及角色，核对新旧池合计连接数，不重放迁移 |
| `MEDIA_ROOT`、媒体开关 | 私有临时目录、`MEDIA_WRITE_MODE=local` 与 `MEDIA_READ_MODE=local` | 运维确认新旧正式 release 共享的绝对媒体路径、权限、读写模式和维护开关，预先验证双方可读 |
| R2 / CDN | 本机启动演练使用 local 模式；需要验证 R2 时用独立 bucket、凭据和 CDN | `R2_*`、`MEDIA_CDN_BASE_URL` 及写入开关取自已核实的正式配置版本 |
| Redis / Socket.IO | 启动演练无通知写入；验证通知时单独准备临时 Redis 与测试 Socket，双方共用测试 `REDIS_URL`、`REDIS_KEY_PREFIX` | 与当前 Socket 的 Redis 实例、DB 和通知前缀配对。确认 presence/adapter 归属与现有 `/socket.io/` upstream |
| JWT | 仅用临时密钥对，配置 `JWT_PRIVATE_KEY_PATH`、`JWT_PUBLIC_KEY_PATH` | 挂载现有兼容密钥，使用权限受限的绝对路径，核对 HTTP 签发与 Socket 验证 |
| 前端及 API | `FRONTEND_URL`、`PUBLIC_API_ORIGIN` 来自受保护测试域名和预览前端，预览单独连接测试 API 与 Socket | 核对正式前端 origin、历史 API 路径和公开资源 URL；正式前端继续使用已配置地址 |
| OAuth | 未配置时可核对状态接口；真实验证使用独立应用和已登记的精确测试 callback | 以供应商登记和目标域名为准核对 Google/GitHub client、secret、`*_REDIRECT_URI` 与前端回跳 |
| AI | 不触发生成；专项验证使用测试模型或受控服务 | 从模型运维配置核对 `OLLAMA_HOST`、`OLLAMA_PORT`、模型清单及工具开关，确认代理首包及长流 |
| 调度 | `BACKGROUND_JOBS_ENABLED=false`，独立 cleanup/ingest 均停用 | HTTP 配置强制关闭清理。沿用当前唯一清理和采集执行方，交接调度时先停并排空旧执行方 |
| 版本及日志 | `BUILD_ID` 用可辨认的本地标识，日志写入临时 release 的 `logs/` | `BUILD_ID` 使用制品中的 `BUILD_SHA`，配置引用纳入记录，日志目录按实例管理 |

PostgreSQL 的增量脚本以已有 Schema 为前提。 [数据库迁移说明](../migrations/README.md)

## 启动、探测、停止与恢复

在当前操作 shell 按上表导出 `CODERX_HONO_RELEASE_DIR`、`APP_ENV_FILE`、`APP_PORT` 与选定的 `PM2_HOME`，然后执行以下命令。先用 `pm2 ls` 确认该守护进程中候选名可用。配置可通过 `node -e 'require(process.argv[1])' "$CODERX_HONO_RELEASE_DIR/deploy/ecosystem.hono.config.cjs"` 无副作用加载。切换 release 或环境文件路径前，记录旧值并按停止步骤删除旧候选定义，再用新值启动。

```bash
pm2 ls
just --justfile "$CODERX_HONO_RELEASE_DIR/justfile" deploy-hono
pm2 describe coderx_hono_candidate
base="http://127.0.0.1:$APP_PORT"
curl --noproxy '*' -fsS --retry 10 --retry-connrefused --max-time 3 "$base/health/live"
curl --noproxy '*' -fsS --retry 10 --retry-connrefused --max-time 3 "$base/health/ready"
```

对照响应中的 `buildId` 与发布记录。`/health/live` 验证 HTTP 监听，`/health/ready` 验证有界的只读 PostgreSQL `SELECT 1`。连接、认证、查询失败或超时会返回 503。Schema、媒体、R2、通知、OAuth 和 AI 各用独立业务探测核对。PM2 的 fork 实例使用进程监督，`wait_ready` 关闭。部署方以 HTTP 健康检查为就绪依据，PM2 `online` 仅表示进程状态。发布前按最长上传、AI 流和后台完成任务核对应用排空时限。可在启动 shell 覆盖 `SHUTDOWN_TIMEOUT_MS`，默认 10000 毫秒，PM2 强制结束时限始终多 5000 毫秒。 [PM2 优雅启停](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/)

停止前守住流量边界。接收正式流量的候选应先执行下节回滚，再排空。停止后检查 PM2 为 `stopped`，确认原 PID 已退出、端口拒绝连接且日志无超时或 SIGKILL。用同一组 release/env/port 和同一 PM2 守护进程再次启动并重跑探测。若需替换配置或恢复保存的候选版本，先删除已停止的候选定义，按保存的值重新执行启动步骤。

```bash
pm2 stop coderx_hono_candidate
pm2 describe coderx_hono_candidate
if curl --noproxy '*' -sS --connect-timeout 2 --max-time 3 "$base/health/live"; then
  printf 'Candidate port still responds\n' >&2
  exit 1
else
  test "$?" -eq 7 || exit 1
fi
# 同一配置恢复
just --justfile "$CODERX_HONO_RELEASE_DIR/justfile" deploy-hono
# 仅在替换候选定义时，对已停止的实例执行
# pm2 delete coderx_hono_candidate
```

本机演练用新的临时 `PM2_HOME`、环境文件、临时 RSA/媒体和可丢弃 PG，令 `BUILD_ID` 明确标记本地构建。准备临时 Nginx 前缀与 pid/logs，将示例作为测试 `http` 块内的 include，仅将监听和 upstream 替换为本次申请的 loopback 端口。先用 `nginx -p <临时前缀>/ -c nginx.conf -t` 校验，再启动同一前缀的实例。分别用 `Host: api.ydp321.asia` 请求 `/health/live`，用测试前端 Host 请求 `/api/health/ready`。停止候选时代理应返回 502，恢复后回到 200。要验证 503，可停止本次新建的 PG，再恢复该 PG，观察 liveness 200、readiness 503→200。结束时关闭该 Nginx 前缀和该 `PM2_HOME` 的守护进程，并清理临时资料。

## Nginx 合并、切流与回滚

以经授权读取的真实 `nginx -T` 和现有 CDN/TLS 设置为准。仓库示例根据历史 `nignx.conf` 保留 `api.ydp321.asia` 根路径、前端 `/api/` 剥前缀和独立 `/socket.io/`。只合并所需 upstream 与 location，保留现有前端静态站点、TLS、访问控制和可信代理设置。用核实的地址替换示例端口，健康端点按实际监控来源配置访问控制，并旁路 CDN 缓存。代理传递 Host、真实地址、转发链和协议；多层 CDN 的地址和协议须沿用已验证的可信配置。现有 Hono AI chat 限流使用 TCP 对端，代理后可能共享同一桶，线上验证时要测并记录。 [Nginx 代理指令](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

HTTP location 使用 HTTP/1.1，关闭请求/响应缓冲和 gzip，保证上传及 AI 流可逐段传输。保留历史 100 MiB 聚合请求体上限，应用另执行文件、数量、解码和字段限制；超过代理上限可先返回 413。180 秒是响应两次读取之间的空闲上限，需按真实首包及流间隔核对。Socket 使用独立 upstream 与 Upgrade，示例 120 秒超过当前 Socket 心跳间隔 25 秒与超时 60 秒之和，合并前对照实际 Socket 设置和边缘代理。 [Nginx WebSocket 配置](https://nginx.org/en/docs/http/websocket.html)

授权切流时保存本次改动前的 vhost/include 与旧 HTTP upstream，核对候选版健康及实际业务，再对同一 Nginx 实例运行 `nginx -t` 并平滑 reload。验证两条 API 入口、真实请求中的 buildId、流首包、上传和通知。旧 HTTP 保留至在途请求和任务排空。异常时先恢复旧 HTTP upstream 和原路由配置，对同一实例语法检查并 reload，验证新请求已到旧版，再排空并停止候选。核实清理/采集仍各只有一个执行方。数据库写入、媒体变更和通知有各自的恢复流程。 [Nginx 信号与 reload](https://nginx.org/en/docs/control.html)

## 发布记录

| 项目 | 记录内容 |
| --- | --- |
| 代码 | Git SHA、工作区是否干净、目标 Node/pnpm、构建及检查结果 |
| 制品 | 文件名、SHA-256、`BUILD_SHA`、release 目录 |
| 配置 | 环境文件引用及版本、PM2 用户/主目录、HTTP/Socket upstream、媒体和密钥挂载引用 |
| 进程 | PM2 名称、状态、PID、启动或退出时间、所属后台任务 |
| 健康 | live/ready 状态与 buildId、探测入口、所用依赖及单项验证结果 |
| 流量 | 当前 HTTP 请求实际到达的版本、前端和 Socket 实际入口、观察时间、旧 upstream 与回滚验证 |
