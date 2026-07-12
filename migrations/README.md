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

| 编号 | 文件                                               | 说明                                                          |
| ---- | -------------------------------------------------- | ------------------------------------------------------------- |
| 001  | `001_fix_file_size_bigint.sql`                     | 修正 `file.size` 从 `integer` 升级到 `bigint`，避免大视频溢出 |
| 002  | `002_create_notifications.sql`                     | 新增站内通知事实表与文章点赞通知冷却查询索引                  |
| 003  | `003_update_notifications_cooldown_index.sql`      | 兼容旧版通知表迁移，删除永久去重约束并补建冷却查询索引        |
| 004  | `004_expand_notifications_for_article_comment.sql` | 扩展文章评论通知，新增 `comment_id` 与 `metadata`             |
| 005  | `005_expand_notifications_for_comment_reply.sql`   | 扩展评论回复通知类型                                          |
| 006  | `006_expand_notifications_for_comment_like.sql`    | 扩展评论点赞通知并新增评论目标类型                            |
| 007  | `007_create_user_tag_preference.sql`               | 新增用户专栏标签个性化顺序关系表                              |
