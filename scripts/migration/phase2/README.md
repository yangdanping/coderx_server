# Koa 到 PostgreSQL 阶段二

本阶段的目标不是修改 Koa 的数据库访问代码，也不是批量改写 MySQL 方言 SQL。

阶段二只做一件事：把 PostgreSQL 影子库 `coderx` 初始化成一个和当前 MySQL `coderx` 足够一致、可重复验证的镜像。这样进入阶段三和阶段四后，应用层问题就能和底层数据问题分开定位。

## 当前交付

- `scripts/migration/phase2/bootstrap-pg.js`
  - 从 MySQL 全量重刷 PostgreSQL 影子库
  - 按外键依赖顺序导入 17 张表
  - 导入后自动校准 identity 序列
  - 导入后自动执行阶段二一致性校验
- `scripts/migration/phase2/verify-parity.js`
  - 检查逐表行数是否一致
  - 检查主键行是否缺失、是否多余
  - 检查行内容样本是否一致
  - 检查 PostgreSQL 侧是否存在外键孤儿
- `test/migration/phase2-utils.test.js`
  - 覆盖阶段二脚本依赖的核心 helper

## 使用方式

在运行 `verify` 或 `bootstrap` 之前，必须先把阶段一 PostgreSQL schema 资产应用到目标 PostgreSQL 库：

- `database/postgresql/001_schema.sql`
- `database/postgresql/002_triggers.sql`
- `database/postgresql/003_indexes.sql`
- 可选但推荐：`database/postgresql/004_verify.sql`

如果这些阶段一表结构还没有安装，阶段二脚本现在会直接失败，而不是在空库或半成品 schema 上继续推导出误导性的校验结果。

先运行只读校验：

```bash
pnpm run migration:phase2:verify -- \
  --env-file /absolute/path/to/.env.development \
  --pg-host localhost \
  --pg-port 5432 \
  --pg-user postgres \
  --pg-password <pg-password> \
  --pg-database coderx
```

如果校验失败，或你希望直接用 MySQL 重刷 PG 影子库，运行：

```bash
pnpm run migration:phase2:bootstrap -- \
  --env-file /absolute/path/to/.env.development \
  --pg-host localhost \
  --pg-port 5432 \
  --pg-user postgres \
  --pg-password <pg-password> \
  --pg-database coderx
```

说明：

- `--env-file` 用于加载 MySQL 连接参数。之所以显式传入，是因为 `.env.development` 被 git 忽略，在隔离工作区里不会自动存在。
- PostgreSQL 参数单独通过 `--pg-*` 提供，避免和现有 `MYSQL_*` 环境变量混淆。
- `bootstrap` 会先 `TRUNCATE ... RESTART IDENTITY CASCADE`，因此它面向的是影子库/阶段库，不应直接对生产库执行。

## 本地回归入口

如果你只是想快速确认当前迁移 worktree 的核心验证面，可以直接运行：

```bash
pnpm run test:migration:regression
```

它会按顺序执行：

- `pnpm run test:migration:phase2`
- `pnpm run test:database:stage3`
- `pnpm run test:migration:hotspots`

## 阶段完成定义

阶段二完成时，应满足以下条件：

- 17 张表在 MySQL 与 PostgreSQL 中行数一致
- 主键行不缺失、不多余
- 抽样行内容一致
- PostgreSQL 侧无外键孤儿

只有达到这些条件，阶段三的“数据库接入解耦”和阶段四的“MySQL 方言 SQL 改写”才有稳定基线。
