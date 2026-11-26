# 文档导航

当前运行架构与生产收尾见[Hono 迁移交接](../HONO_MIGRATION.md)。

## 当前指南

- [安装、启动与环境](../README.md)、[环境模板](../.env.example)
- [数据库迁移及历史前置条件](../migrations/README.md)：不包含全新数据库的完整基础 Schema
- [Flow 发布协议、验收与部署边界](../FLOW_PUBLICATION.md)
- [文章采集、原文发布与媒体重试](../CONTENT_INGEST.md)
- [存量媒体迁移 CLI](./media-migration.md)
- [JWT 密钥管理](../src/app/keys/README.md)
- [HTTP 发布与回滚手册](../deploy/README.md)

## 历史与本地资料

- [Flow 首次上线前记录](./history/flow-first-release-2026-10.md)：旧的未上线状态已过期，保留首次部署与回退背景
- [Koa → Hono 验收记录](./superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md)保存本地验收、隔离测试、切流和回滚依据
- `superpowers/plans/`、`superpowers/specs/` 中的旧设计和实施快照按记录日期查阅
- 本地被忽略的交接记录、生产备份、密钥和验收文件不随克隆分发，也不属于应随文档清理删除的内容
