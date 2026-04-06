# Koa MySQL → PostgreSQL 迁移：整合收尾指南

Last Updated: `2026-04-06`
Status: **Cutover-Ready** — 6 个阶段全部完成，等待合并与正式切流

## 一句话概要

coderx 应用的 MySQL → PostgreSQL 迁移已完成全部开发、验证和演练。12 个 SQL 模块全部双方言就绪，167 项回归测试 + 8 条双库 parity evidence 全部 PASS，本地切流演练（PG 冒烟 + MySQL 回退）通过。下一步是合并 PR 并正式切流。

## 背景

用户最初只是想把 `comment.service.js` 里的 MySQL 方言 SQL 改成 PG 方言。但由于项目**没有任何自动化测试基座**，"改 SQL"只占 ~20% 工作量，剩下 ~80% 花在"证明改完后两边跑出一模一样的结果"上。因此演化出了 6 个阶段。

## 完成状态总览

| 阶段 | 内容 | 状态 |
|------|------|------|
| Stage 1 | PG 建表/触发器/索引/校验脚本 | ✅ 完成 |
| Stage 2 | MySQL → PG 全量导入 + 逐表校验工具 | ✅ 完成 |
| Stage 3 | DB adapter 兼容层（dialect 切换） | ✅ 完成 |
| Stage 4 | 12 个 service/task 的 SQL builder 迁移 | ✅ 完成 |
| Stage 5 | controller 回归 + 8 条双库 parity 对比 | ✅ 完成 |
| Stage 6 | 切流/回退演练 | ✅ 完成 |

## PR 与分支

- **PR**: https://github.com/yangdanping/coderx_server/pull/1
- **分支**: `phase2-pg-bootstrap`
- **Worktree**: `.worktrees/phase2-pg-bootstrap`
- **Commits** (按阶段组织):
  1. `feat(pg): add PostgreSQL schema assets for 17 tables`
  2. `feat(pg): add Phase 2 migration tooling and schema guard`
  3. `feat(pg): add database adapter layer with dialect switching`
  4. `feat(pg): migrate 12 SQL modules to dual-dialect builders with tests`
  5. `feat(pg): add 8 dual-engine parity evidence toolchains and reports`
  6. `feat(pg): Stage 6 cutover rehearsal PASS + rollback runbook`

## 验证证据

### 回归测试

```bash
pnpm run test:migration:regression  # 167 tests, 0 failures
```

子套件：`test:migration:phase2` (9) + `test:database:stage3` (8) + `test:migration:hotspots` (105) + `test:migration:phase5` (45)

### 双库 Parity Evidence（全部 PASS）

| 工具链 | 覆盖链路 | 报告 |
|--------|---------|------|
| `article-read` | getDetail, getList(date/hot), getRecommendList, search | `2026-04-06-article-read-parity-report.json` |
| `comment-read` | getCommentList:latest/hot, getReplies | `2026-04-06-comment-read-parity-report.json` |
| `comment-write` | addComment, addReply:toComment/toReply | `2026-04-06-comment-write-parity-report.json` |
| `history` | getUserHistory, addHistory (double-upsert) | `2026-04-06-history-parity-report.json` |
| `collect` | getCollectList, getCollectArticle, addCollect | `2026-04-06-collect-parity-report.json` |
| `user-auth` | checkStatus, getUserByName, getProfileById, getLikedById, getFollowInfo, findUserByEmail | `2026-04-06-user-auth-parity-report.json` |
| `file-meta` | getArticleImages, getArticleVideos | `2026-04-06-file-meta-parity-report.json` |
| `clean-orphan` | findOrphanFiles:image/video | `2026-04-06-clean-orphan-parity-report.json` |

### Stage 6 切流演练

- **全量导入验证**: 17 张表行数 MySQL ↔ PG 完全一致，identity 序列 >= max(id)
- **PG 模式冒烟**: 8/8 核心接口 200 OK（文章详情/列表/搜索/推荐、评论列表/回复、标签列表、热门用户）
- **MySQL 回退**: 切回后所有接口正常
- **Rollback Runbook**: `docs/cutover-rollback-runbook.md`

## 迁移涉及的文件清单

### 核心架构

| 文件 | 作用 |
|------|------|
| `src/app/config.js` | 新增 `DB_DIALECT`, `PG*` 环境变量 |
| `src/app/database.js` | 委托给 adapter 层 |
| `src/app/database/index.js` | dialect 路由 |
| `src/app/database/dialect.js` | dialect 归一化 |
| `src/app/database/mysql.client.js` | MySQL 客户端 |
| `src/app/database/pg.client.js` | PG 客户端 |
| `src/app/database/pg.config.js` | PG 连接配置 |
| `src/app/database/pg.utils.js` | placeholder 转换、结果封装 |

### SQL 双方言 Builder（12 对）

| Service | SQL Builder |
|---------|-------------|
| `article.service.js` | `article.sql.js` |
| `auth.service.js` | `auth.sql.js` |
| `avatar.service.js` | `avatar.sql.js` |
| `collect.service.js` | `collect.sql.js` |
| `comment.service.js` | `comment.sql.js` |
| `history.service.js` | `history.sql.js` |
| `image.service.js` | `image.sql.js` |
| `oauth.service.js` | `oauth.sql.js` |
| `tag.service.js` | `tag.sql.js` |
| `user.service.js` | `user.sql.js` |
| `video.service.js` | `video.sql.js` |
| `tasks/cleanOrphanFiles.js` | `tasks/cleanOrphanFiles.sql.js` |

### 迁移过程中的生产 Bug 修复

| 文件 | 修复内容 |
|------|---------|
| `src/controller/article.controller.js` | `getDetail()` 对任意 truthy `status` 做封禁遮罩；`getList()` 非法 `pageOrder` 归一到 `date` |
| `src/controller/comment.controller.js` | `getCommentList()` 处理 `null` 返回；`getReplies()` 非正 `limit` 归一到 `10` |

### PostgreSQL 资产

- `database/postgresql/000_reset_data.sql` ~ `004_verify.sql`, `README.md`, `import_mysql_dump_to_pg.py`
- `005_data_from_mysql_dump.sql` **不应入库**（环境相关生成文件）

### 迁移工具与测试

- `scripts/migration/phase2/` — 全量导入 + 校验工具
- `scripts/migration/verify-*-parity.js` × 8 — 双库 parity evidence
- `test/` 下对应的 167 项测试

## 正式切流操作指南

详见 `docs/cutover-rollback-runbook.md`，核心流程：

### 切流

```bash
# 1. 停止当前应用
kill $(lsof -ti :8000)

# 2. 如有新写入，重新全量同步
pnpm run migration:phase2:bootstrap -- --env-file .env --pg-password <pwd>

# 3. 修改 .env
#    DB_DIALECT=pg
#    PGHOST=127.0.0.1  PGPORT=5432  PGDATABASE=coderx  PGUSER=postgres  PGPASSWORD=<pwd>

# 4. 启动
NODE_ENV=production node ./src/main.js

# 5. 冒烟验证（见 runbook 中的 curl 清单）
```

### 回退（< 1 分钟）

```bash
kill $(lsof -ti :8000)
# 改 .env: DB_DIALECT=mysql
NODE_ENV=production node ./src/main.js
```

### Stop Conditions（任一触发立即回退）

- 接口 5xx
- SQL 执行报错
- 结果集与 MySQL 不一致
- 写入后读不回
- 事务语义异常

## 合并后的清理建议

合并 PR 后可考虑：

1. **删除 worktree**: `git worktree remove .worktrees/phase2-pg-bootstrap`
2. **清理迁移工具**（可选）: `scripts/migration/` 和 `test/migration/` 中的 parity evidence 工具在正式切流完成后可归档或删除
3. **移除 MySQL 兼容层**（可选，正式切流稳定后）: 当确认不再需要 MySQL 回退时，可移除 `src/app/database/mysql.client.js` 和各 `*.sql.js` 中的 mysql 分支
4. **更新旧评估文档**: `docs/04_项目优化沙盒推演/02_MySQL 到 PostgreSQL 迁移评估.md` 结论应从"暂不建议迁移"更新为"已完成迁移"

## 连接信息

| 系统 | Host | Port | Database | User |
|------|------|------|----------|------|
| MySQL | localhost | 3306 | coderx | root |
| PostgreSQL | 127.0.0.1 | 5432 | coderx | postgres |

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -d coderx
# Password: 123456
```

## 典型迁移语法对照（速查）

| MySQL | PostgreSQL |
|-------|-----------|
| `JSON_OBJECT(...)` | `jsonb_build_object(...)` |
| `JSON_ARRAYAGG(...)` | `jsonb_agg(...)` |
| `LIMIT ?, ?` | `LIMIT $n OFFSET $m` |
| `ON DUPLICATE KEY UPDATE` | `ON CONFLICT (...) DO UPDATE SET` |
| `UPDATE ... INNER JOIN` | `UPDATE ... FROM ... WHERE` |
| `insertId` | `RETURNING id` |
| `TIMESTAMPDIFF(SECOND, ...)` | `EXTRACT(EPOCH FROM ...)` |
| `DATE_SUB(NOW(), INTERVAL ...)` | `NOW() - INTERVAL '...'` |
| `tinyint(1)` 0/1 | `BOOLEAN` true/false |
| `?` placeholder | `$1, $2, ...` (adapter 层自动转换) |
