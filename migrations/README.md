# 数据库迁移脚本（Schema Migrations）

手动维护的增量 DDL 脚本。编号用于整理变更顺序，不代表任何环境已经执行，也不是自动迁移状态；执行时仍需核对结构、历史记录和前置依赖。

> [!IMPORTANT]
> 这里保存的是现有 CoderX 基础 Schema 之上的增量变更，不包含完整的历史建库脚本。全新环境需要先恢复基础 Schema，再执行尚未应用的迁移。

## 使用方法

先比对目标库结构与每份脚本，结合部署记录确认哪些变更尚未应用，并核对下方历史前置条件。以下仅示例如何执行一份已确认需要的脚本：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_fix_file_size_bigint.sql
```

或在 Navicat / DBeaver / pgAdmin 里依次打开执行。

仓库当前没有自动维护 `schema_migrations` 表，因此不要对状态不明的生产数据库批量重放全部文件。脚本不保证幂等，不能仅凭最大编号推断先前脚本已全部应用，也不要盲目重跑。部署记录应逐份保存脚本路径、执行时间、目标环境和结果。

## 历史前置脚本

`prerequisites/2026-08-11-draft-type.sql` 保存原 `docs/10_flow/sql/2026-08-11-draft-type.sql` 的原始内容，补齐先前未跟踪的 Flow 草稿前置条件；它不是新的业务变更，也没有重新编号。

首次启用 Flow 的旧环境须先核对 `draft.draft_type`、类型约束和三个 active 唯一索引；只有尚未应用时，才先执行该历史脚本，再执行 `012_create_flow_post.sql`。该脚本含 `ADD COLUMN` 和 `ADD CONSTRAINT`，**不能直接重跑**。已具备这些变更的环境只记录核对结果，不重复执行。先恢复基础 Schema；此目录和编号迁移都不能单独创建完整空库。

草稿脚本会替换文章草稿唯一索引，旧代码不能继续写入迁移后的数据库。停写、备份和回退边界见 [Flow 发布说明](../FLOW_PUBLICATION.md)。

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
| 008  | `008_create_content_ingest_pipeline.sql`           | 新增 AI 内容来源、候选池、运行审计与正式文章来源归属          |
| 009  | `009_add_profile_nickname.sql`                     | 新增可选、可重名且受字符约束的用户展示昵称                    |
| 010  | `010_create_media_object.sql`                      | 新增逻辑媒体在本地磁盘或 R2 的物理对象映射与校验约束          |
| 011  | `011_create_media_local_cleanup.sql`               | 新增 EC2 媒体删除 outbox，支持崩溃后幂等重试                  |
| 012  | `012_create_flow_post.sql`                         | 新增 Flow 动态、媒体关联及幂等发布约束                        |
