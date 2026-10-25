# AI 内容采集与回填

内容采集流水线从公开 RSS/Atom 来源建立候选，经过评分、去重和人工审核后发布。默认采用保留原文的 `backfill-raw`，不调用模型；旧的审批/模型增强流程单列在后文。抓取、审批与发布都通过独立 CLI/Worker 运行，不依赖 Koa 登录态。

## 安全边界

- 默认 `INGEST_ENABLED=false`，定时采集关闭；显式 CLI 命令仍可写库。
- 默认 `INGEST_AUTO_PUBLISH=false`，`run` 不会自动发布；显式 `publish`、`backfill-raw` 和 `backfill-rich` 不受该开关限制。
- 候选先写入 `ingest_candidate`，不会在采集阶段直接创建文章。
- `backfill-raw` 和 `backfill-rich` 必须传入明确 ID，单次最多 5 篇。
- `INGEST_AUTHOR_IDS` 只能包含已授权的现有活跃用户，多篇批次不得重复使用同一作者。
- 在生产环境保存原图前，必须确认来源允许转载；许可不明确时改用自有或生成图片。

## 数据流

```text
公开 RSS/Atom
      ↓
规范化、评分、去重
      ↓
ingest_candidate 候选池
      ↓
人工审核并选择明确 ID
      ↓
pending 候选发布 / published 候选原位回填
```

canonical URL、来源 external ID 和内容哈希都有唯一约束，重复采集不会重复入库。

## 前置条件

1. 按 [数据库迁移说明](./migrations/README.md) 应用尚未执行的增量迁移，其中 `008_create_content_ingest_pipeline.sql` 创建采集表。
2. 在 `.env.development` 或 `.env.production` 配置 PostgreSQL。
3. 发布或回填前配置现有作者与标签。
4. 使用 `enrich`、`backfill-rich`、`run` 或启用定时 Worker 时配置 Ollama/OpenAI 兼容模型（`run` 包含 `enrich`）。使用完整的 `INGEST_OLLAMA_BASE_URL`；若留空，回退地址要求 `OLLAMA_HOST` 为不带协议的主机名，与 Web AI 的带协议写法不同，建议始终显式配置采集地址。
5. 采集媒体登记需要媒体表和 Flow 媒体关联表，核对迁移 `010`、`011`、`012` 及 Flow 的历史草稿前置条件。媒体写模式与 HTTP 服务共用 `MEDIA_*`、`R2_*` 配置，见 [.env.example](./.env.example)。

关键配置：

| 变量                     | 默认值                      | 说明                             |
| ------------------------ | --------------------------- | -------------------------------- |
| `INGEST_ENABLED`         | `false`                     | 是否允许定时 Worker 执行         |
| `INGEST_AUTO_PUBLISH`    | `false`                     | `run` 是否发布已审批候选         |
| `INGEST_CRON`            | `15 7 * * *`                | node-cron 表达式                 |
| `INGEST_TIMEZONE`        | `Asia/Shanghai`             | 调度时区                         |
| `INGEST_DAILY_LIMIT`     | `10`                        | 单次默认处理上限                 |
| `INGEST_DAYS`            | `30`                        | 默认回看天数                     |
| `INGEST_AUTHOR_NAME`     | 留空                        | 旧发布流程使用的现有用户名       |
| `INGEST_AUTHOR_IDS`      | 留空                        | 原文/富媒体回填允许使用的用户 ID |
| `INGEST_TAG_NAME`        | `人工智能`                  | 发布文章使用的标签               |
| `INGEST_OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI 兼容模型地址              |
| `INGEST_OLLAMA_MODEL`    | `qwen2.5:7b`                | 内容处理模型                     |

## 常用流程

### 1. 收集候选

```bash
pnpm ingest collect --days 30 --limit 100 --per-source-limit 20
```

日常采集默认遵循各来源的 `dailyLimit`，再按总分选出全局前 10 条。`--per-source-limit` 主要用于首次回填。

### 2. 人工审核原文候选

```bash
pnpm ingest list --status pending,published --limit 60
pnpm ingest list --status pending,published --limit 60 --json
pnpm ingest list --status pending,published --limit 60 --json \
  --output data/ingest-batches/review.json
```

本步骤是人工审核列表并选择明确 ID，不执行 `approve`。原文入口只接受未映射的 `pending` 或已有文章映射的 `published` 候选；不要先走 `enrich → approve`；前者会把候选变成 `enriched`，后者只审批 `enriched` 候选并改为 `approved`，均不属于原文新建的 `pending` 状态。

### 3. 原文发布或回填（默认方式）

```bash
INGEST_AUTHOR_IDS=1,2,3,4,5 \
pnpm ingest backfill-raw --ids 72,3,35,23,55 --limit 5
```

`backfill-raw` 不调用模型。未映射的 `pending` 候选会发布为新文章；已映射的 `published` 候选会原位更新。正文转换为可编辑的 Tiptap JSON，合格图片保存到本站，原图和缩略图登记到 `media_object`；使用 R2 写模式时继续执行上传与校验。正文事务提交与媒体同步结果分开报告，提交后媒体失败不会回滚已发布文章或删除其新图片。

### 4. 重试已提交文章的媒体同步

```bash
# 此处为正式文章 ID，不是候选 ID；单次最多 5 个，不接受重复 ID
pnpm ingest retry-media --ids 301,302 --limit 2
```

原文/富媒体命令结果中的 `media.status` 可能为 `ready`、`local_ready` 或 `retry_required`。后者需要检查 `registration`、`promotion`、`cleanup` 与 `reason`；修复文件或 R2 配置后按返回的 `articleId` 执行 `retry-media`，不必重新发布文章。`MEDIA_MUTATIONS_PAUSED=true` 禁止回填媒体写入；暂停时重试返回 `retry_required`。

## 可选旧流程：模型增强与审批发布

以下命令仍保留在代码中，只有明确需要中文增强或旧模板发布时才使用，不属于上述原文流程：

```bash
pnpm ingest enrich --limit 60

INGEST_AUTHOR_IDS=1,2,3,4,5 \
INGEST_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 \
INGEST_OLLAMA_MODEL=qwen2.5:7b \
pnpm ingest backfill-rich --ids 70,21,54,149,60 --limit 5
```

`enrich` 生成中文标题、摘要和推荐理由；`backfill-rich` 生成中文重写稿。两者不是默认发布路径。

旧模板流程使用 `enrich → approve → publish`，不是 `backfill-raw` 的前置步骤：

```bash
pnpm ingest list --status pending,enriched --limit 60
pnpm ingest approve --ids 31,32 --limit 2
pnpm ingest publish --limit 10
```

`approve` 只接受 `enriched` 候选；不传 `--ids` 时按评分审批指定数量。`publish` 使用 `INGEST_AUTHOR_NAME` 和 `INGEST_TAG_NAME` 对应的现有用户、标签，不会自动创建。生产操作需先核对明确的候选范围。

## 清理旧占位文章

```bash
# 只输出审核清单
pnpm ingest purge-placeholders

# 审核后显式事务删除
pnpm ingest purge-placeholders --apply
```

清理命令只匹配包含固定“摘要 / 为什么值得阅读 / 来源 / 阅读原文”Tiptap 标记的旧模板文章；没有 `--apply` 时不会修改数据。

## 生产环境的手动命令

`pnpm ingest` 脚本固定使用 `NODE_ENV=development`，即使外部设置 `NODE_ENV=production` 也会覆盖。生产手动操作应明确运行 CLI，使它读取 `.env.production`：

```bash
NODE_ENV=production node src/ingest/cli.js list --status pending,published --limit 60 --json
```

所有示例中的 ID 都是占位示例；对实际目标库审批、发布、回填或清理前需核对候选与作者。

## 定时 Worker（包含模型增强，非默认原文路径）

```bash
pnpm start:ingest
```

原文采集默认保持 `INGEST_ENABLED=false`；不要为运行原文批次启用当前 Worker。`run` 依次执行 `collect` 和 `enrich`。只有显式设置 `INGEST_AUTO_PUBLISH=true` 时才会继续发布已审批候选。

PM2 中的 `coderx_ingest_worker` 固定为一个 fork 实例；node-cron 使用 `noOverlap`，采集入口再使用 PostgreSQL advisory lock，避免手动任务和定时任务同时写库。

生产启用顺序：

1. 保持 `INGEST_ENABLED=false`、`INGEST_AUTO_PUBLISH=false` 启动 Worker。
2. 手动运行 `collect`、`list`，确认来源质量和去重结果。
3. 设置 `INGEST_ENABLED=true` 开启定时采集，继续保持自动发布关闭。
4. 通过明确 ID 审批和发布；只有人工流程稳定后再评估自动发布。
