# 文档导航

维护日期：2026-10-25。当前后端使用 Koa 3、CommonJS 和 PostgreSQL。

## 当前指南

- [安装、启动与环境](../README.md)、[环境模板](../.env.example)
- [数据库迁移及历史前置条件](../migrations/README.md)：不包含全新数据库的完整基础 Schema
- [Flow 发布协议、验收与部署边界](../FLOW_PUBLICATION.md)
- [文章采集、原文发布与媒体重试](../CONTENT_INGEST.md)
- [存量媒体迁移 CLI](./media-migration.md)
- [JWT 密钥管理](../src/app/keys/README.md)
- [Hono 迁移决定：暂不实施](../HONO_MIGRATION.md)

## 历史与本地资料

- [Flow 首次上线前记录](./history/flow-first-release-2026-10.md)：旧的未上线状态已过期，保留首次部署与回退背景
- `superpowers/plans/`、`superpowers/specs/`：历史设计和实施快照；旧分支、路径、依赖版本、环境状态及未勾选项不代表当前操作或待办
- 本地被忽略的交接记录、生产备份、密钥和验收文件不随克隆分发，也不属于应随文档清理删除的内容

截至 2026-10-21 整合，两仓库本地与远程均只保留 `main`。后续部署从已核验的 `origin/main` 获取代码，不再依赖旧工作分支。仓库推送与生产部署须分别记录。
