# Koa MySQL → PostgreSQL 切流与回退 Runbook

Last Rehearsed: `2026-04-06`

## 前置条件

- MySQL `coderx` 数据库正常运行且数据完整
- PostgreSQL `coderx` 数据库已通过 Stage 2 全量导入并校验
- 17 张表行数一致，identity 序列已重置（`last_value >= max(id)`）
- Stage 5 全部 8 条 parity evidence PASS
- 167 regression tests PASS

## 连接信息

| 系统 | Host | Port | Database | User | Password |
|------|------|------|----------|------|----------|
| MySQL | localhost | 3306 | coderx | root | (see .env) |
| PostgreSQL | 127.0.0.1 | 5432 | coderx | postgres | (see .env) |

## 切流步骤

### Step 1: 停写（短维护窗口）

```bash
# 停止当前 Koa 应用
kill $(lsof -ti :8000)
```

### Step 2: 最终全量同步

如果 MySQL 在 Stage 2 导入后有新的写入，需要重新导入：

```bash
cd /path/to/worktree
pnpm run migration:phase2:bootstrap -- \
  --env-file /path/to/.env.development \
  --pg-password <pg_password>
```

导入后校验：

```bash
pnpm run migration:phase2:verify -- \
  --env-file /path/to/.env.development \
  --pg-password <pg_password>
```

### Step 3: 切流到 PostgreSQL

修改 `.env.development`（或 `.env.production`）：

```diff
-# DB_DIALECT=mysql  (或不设置，默认 mysql)
+DB_DIALECT=pg
+PGHOST=127.0.0.1
+PGPORT=5432
+PGDATABASE=coderx
+PGUSER=postgres
+PGPASSWORD=<pg_password>
```

### Step 4: 启动应用

```bash
NODE_ENV=development node ./src/main.js
# 或
NODE_ENV=production node ./src/main.js
```

确认日志输出：`服务器在端口8000启动成功~`

### Step 5: 冒烟验证

```bash
# 文章详情
curl -s http://localhost:8000/article/21 | python3 -m json.tool | head -5

# 文章列表
curl -s 'http://localhost:8000/article?pageNum=1&pageSize=3&pageOrder=date' | python3 -m json.tool | head -5

# 评论列表
curl -s 'http://localhost:8000/comment?articleId=21&sort=latest&pageNum=1&pageSize=5' | python3 -m json.tool | head -5

# 标签列表
curl -s 'http://localhost:8000/tag?pageNum=1&pageSize=5' | python3 -m json.tool | head -5

# 热门用户
curl -s http://localhost:8000/user/hot | python3 -m json.tool | head -5

# 推荐文章
curl -s 'http://localhost:8000/article/recommend?pageNum=1&pageSize=3' | python3 -m json.tool | head -5

# 搜索
curl -s 'http://localhost:8000/article?keyword=Vue&pageNum=1&pageSize=3&pageOrder=date' | python3 -m json.tool | head -5

# 评论回复
curl -s 'http://localhost:8000/comment/60/replies?limit=3' | python3 -m json.tool | head -5
```

所有接口应返回 HTTP 200 + 有效 JSON 数据。

### Step 6: 观察窗口

- 维持至少 30 分钟观察
- 检查应用日志，确认无 SQL 错误
- 若出现任何 stop condition → 立即执行回退

## Stop Conditions（任何一条触发立即回退）

- 接口返回 5xx 错误
- SQL 执行报错（日志中出现 `✗ SQL执行失败`）
- 结果集数据不一致（与 MySQL 对比）
- 写入后读不回（INSERT 后查询不到）
- 事务语义变化（部分提交或回滚异常）

## 回退步骤

### Step R1: 停止 PG 模式应用

```bash
kill $(lsof -ti :8000)
```

### Step R2: 切回 MySQL 配置

修改 `.env.development`（或 `.env.production`）：

```diff
-DB_DIALECT=pg
+DB_DIALECT=mysql
# PG* 变量可保留，不影响 MySQL 模式
```

### Step R3: 重启应用

```bash
NODE_ENV=development node ./src/main.js
```

确认日志输出：`coderx 数据库连接成功!`

### Step R4: 冒烟验证

执行与 Step 5 相同的 curl 命令，确认 MySQL 模式全部正常。

## 注意事项

- MySQL 数据库本身不做任何 destructive 操作，切流期间保持原样
- 切流后若已有新数据仅写入 PG，这些数据**不会自动回灌**到 MySQL
- 如需回灌，需要单独评估（可能需要 Stage 2 工具的反向导入或手动处理）
- 切流前保留最新 MySQL 全量备份

## 演练记录

| 日期 | 环境 | 步骤 | 结果 |
|------|------|------|------|
| 2026-04-06 | 本地开发 | 全流程（Step 1-6 + R1-R4） | PASS |

### 2026-04-06 演练详情

- PG 模式冒烟：8/8 核心接口正常（文章详情/列表/搜索/推荐、评论列表/回复、标签列表、热门用户）
- 收藏列表返回 405 是路由层认证问题，非 PG 相关
- MySQL 回退冒烟：所有接口正常
- 数据一致性：17 张表行数一致，序列值全部 >= max(id)
