# AI 内容采集服务设计

## 目标

为 CoderX 的“人工智能”板块建立一个脱离 Koa、可独立运行的 Node.js 内容采集服务。首期从无需登录的公开 RSS/Atom 来源采集内容，默认保存“来源标题、摘要、推荐理由和原文链接”，仅对明确允许转载的白名单来源保留全文能力。首次回填目标为最近 30 天最多 60 条候选，稳定运行后每天最多发布 8–10 篇。

## 范围与边界

- 采集器不导入 Koa、Controller、Router 或 `ctx`。
- 采集器与 HTTP API 只共享 PostgreSQL 数据库适配器、文章正文工具和少量领域模块；若未来另行决定采用 Hono，也必须保持这条边界。
- 首期不依赖 Google 登录态，不抓取需要登录、验证码或浏览器自动化的网站。
- 首期不复制第三方全文和图片；候选正文仅包含站内摘要、推荐理由、来源信息和原文链接。
- Google 登录可在未来需要管理后台人工审批时复用，但不属于本次采集链路。
- 本次只改后端仓库；现有前端文章列表可直接展示最终发布的标准 `article` 数据。

## 运行架构

PM2 新增单独的 `coderx_ingest_worker` 进程。该进程由 `node-cron` 定时唤醒采集任务，Koa 与 Socket 进程不参与调度。

Worker 默认使用 `Asia/Shanghai` 时区和 `0 7 * * *` 表达式。`node-cron` 的 `noOverlap` 防止同一进程内叠加执行；每轮任务再通过 PostgreSQL session advisory lock 防止多个进程或多台机器同时执行。锁使用同一条专用数据库连接持有，并在 `finally` 中释放；连接异常结束时 PostgreSQL 也会自动回收锁。

`INGEST_ENABLED=false` 时 Worker 保持运行但每次调度只记录跳过，不采集、不发布。`INGEST_AUTO_PUBLISH=false` 是生产默认值，即使启用采集也只写候选池。

## 数据模型

### `ingest_source`

记录来源稳定标识、名称、Feed URL、主页、默认内容模式、转载许可标识、每日上限、启用状态和可信度权重。来源配置由代码维护，运行时以稳定 `source_key` 幂等写入数据库。

### `ingest_run`

记录一次手动或定时任务的开始/结束时间、运行模式、状态、统计 JSON 和错误摘要，用于审计与排障。

### `ingest_candidate`

保存规范化 URL、来源文章 ID、原始标题/摘要、中文标题/摘要、推荐理由、评分、结构化正文、内容指纹、来源发布时间和生命周期状态。

候选状态限定为：

- `pending`：已采集，尚未完成中文化；
- `enriched`：已生成站内展示内容；
- `approved`：已批准发布；
- `rejected`：人工或规则拒绝；
- `published`：已生成正式文章；
- `failed`：处理失败，可重试。

`canonical_url` 全局唯一，`(source_id, external_id)` 在 external ID 非空时唯一，`content_hash` 在非空时唯一，形成三层幂等保护。

### `article_source`

一对一关联正式文章和采集候选，保存来源、规范化原文 URL、原始标题、原始发布时间、内容模式与许可标识。`canonical_url` 唯一，避免绕过候选表重复发布。

## 采集与筛选

来源适配器统一输出：

```js
{
  externalId,
  url,
  title,
  summary,
  publishedAt,
  author,
  raw
}
```

RSS/Atom 解析器只读取标题、链接、GUID/ID、摘要、发布时间和作者，不加载全文页面。URL 规范化会删除 fragment、常见追踪参数和无意义尾部斜杠，再排序剩余查询参数。

每个条目根据以下维度计算 0–100 分：

- 时效性：0–40；
- AI 关键词相关性：0–40；
- 来源可信度：0–20。

首次回填默认看最近 30 天，每个来源最多取 20 条，总候选最多 100 条；审批阶段按评分选前 60 条。每日发布时再执行来源每日上限，防止单一来源占满列表。

## 中文化与正文

中文化适配器使用独立的 OpenAI-compatible/Ollama 客户端，不依赖现有 Koa AI Controller。输入仅包含来源名称、标题和清洗后的摘要；结构化输出为：

```js
{
  titleZh,
  summaryZh,
  recommendation,
  keywords
}
```

AI 未启用或不可用时，候选保持 `pending`，不会用不完整内容自动发布。命令行可以稍后重试 enrichment。

站内正文继续使用现有 Tiptap JSON 契约，包含：

1. 中文摘要；
2. “为什么值得阅读”的推荐理由；
3. 来源、原始发布时间和内容说明；
4. 带 `noopener noreferrer` 语义的原文链接。

标题在写正式文章前按现有数据库约束限制为 50 个字符。

## 审批与发布

命令行提供 `collect`、`enrich`、`list`、`approve`、`publish` 和 `run` 子命令。

- `collect`：抓取并幂等写候选；
- `enrich`：对 pending 候选生成中文内容；
- `list`：以 JSON 或表格形式查看候选；
- `approve`：按显式 ID 或评分前 N 条批准；
- `publish`：只发布 approved 候选；
- `run`：供定时 Worker 调用完整流水线。

发布在一个数据库事务内完成：

1. `FOR UPDATE SKIP LOCKED` 锁定待发布候选；
2. 根据 `INGEST_AUTHOR_NAME` 查找系统作者；
3. 根据 `INGEST_TAG_NAME` 查找“人工智能”标签；
4. 写入标准 `article`；
5. 写入 `article_tag`；
6. 写入 `article_source`；
7. 将候选标记为 `published` 并记录 `article_id`；
8. 提交事务。

系统不会自动创建作者账号。缺少作者或标签时发布命令失败并回滚，避免生产环境静默写入错误归属。

## 本地与生产同步

本地数据库和生产数据库不做整库或表级同步。

- 代码：通过 Git 和现有 `just deploy` 流程同步；
- Schema：通过编号 migration 在本地验证后单独应用到生产；
- 首批内容：候选可导出为不含数据库 ID 的 JSON batch，生产通过规范化 URL 幂等导入；
- 日常内容：生产 Worker 自行抓取，不依赖开发机在线。

上线顺序：

1. 本地执行 migration、测试和首次抓取；
2. 检查本地候选与首批 enrichment；
3. 部署代码和 migration，但保持 `INGEST_ENABLED=false`；
4. 在生产手动执行一次 `collect`，仍保持 `INGEST_AUTO_PUBLISH=false`；
5. 影子运行 2–3 天；
6. 确认后才启用自动发布。

本次任务停在第 2 步完成之后，不触碰生产服务器。

## 错误处理与可观测性

- 单个来源失败不终止其他来源，错误进入本轮 `stats`；
- HTTP 请求设置超时、明确 User-Agent，不无限重试；
- 解析失败记录来源和错误摘要，不保存不完整候选；
- AI 失败将候选保留为可重试状态；
- 发布失败整批事务回滚；
- 每轮运行记录 collected、duplicate、enriched、approved、published、failed 和 sourceErrors；
- CLI 以非零退出码表示整轮不可用或数据库操作失败。

## 验证

- Node 单元测试覆盖 URL 规范化、RSS/Atom 解析、评分、Tiptap 正文和配置边界；
- SQL contract 测试覆盖 migration 的约束、索引和幂等语义；
- Repository/Runner 测试使用依赖注入验证 advisory lock、来源隔离失败和发布事务；
- 本地 PostgreSQL 应用 migration 后用真实查询验证表、约束与索引；
- 首批采集只进入本地候选表，统计来源分布、重复数、时间范围和前 60 条质量；
- 全量 `pnpm test` 验证现有 328 项后端测试无回归。
