# 数据库迁移脚本（Schema Migrations）

手动维护的 DDL 变更脚本，按文件名前缀序号**顺序执行**。

## 使用方法

连接到 PG 数据库后逐个执行：

```bash
psql "$DATABASE_URL" -f migrations/001_fix_file_size_bigint.sql
```

或在 Navicat / DBeaver / pgAdmin 里依次打开执行。

## 约定

- 文件名格式：`NNN_snake_case_description.sql`（NNN 自增三位数）
- 每个脚本尽量用 `BEGIN; ... COMMIT;` 包裹，确保失败时自动回滚
- 变更如果涉及大表，注释里注明数据量级和预计耗时
- 不要在已执行的脚本里改内容；有新变更请新增下一个编号文件

## 历史

| 编号 | 文件 | 说明 |
|---|---|---|
| 001 | `001_fix_file_size_bigint.sql` | 修正 `file.size` 从 `integer` 升级到 `bigint`，避免大视频溢出 |
