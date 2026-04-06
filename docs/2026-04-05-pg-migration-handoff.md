# Koa -> PostgreSQL Migration Handoff

Last Updated: `2026-04-06` (Stage 5 parity evidence surface fully expanded)

## 交接用途

这份文档的目标消费者就是下一位接手 `phase2-pg-bootstrap` worktree 的 agent。重点不是回放所有过程，而是说明：

- 现在已经完成了什么
- 当前停在什么位置
- 接下来最值得继续做什么

## 来时路

这部分补充迁移的动因、演进脉络和关键认知，帮助接手 agent 理解"为什么走到了今天这个结构"。

### 动因

用户的初衷极其直接：把 `comment.service.js` 里类似 `JSON_OBJECT(...)` 的 MySQL 方言 SQL 改成 PostgreSQL 方言。MySQL 的 `coderx` 数据库结构和数据已经完整导入了 PG。看起来只是一个"找到 MySQL 专属语法，换成 PG 等价物"的操作。

### 为什么变成了 6 个阶段

实际执行中，"改 SQL"本身只占 ~20% 的工作量。剩下 ~80% 花在"证明改完之后 MySQL 和 PG 跑出来结果一模一样"上。根本原因是：**这个项目之前没有任何自动化测试基座**。改了 SQL 不验证，切流后炸了没人知道。

| 阶段 | 做了什么 | 为什么不能跳过 |
|---|---|---|
| **Stage 1** | PG 建表/触发器/索引/校验脚本 | 没有表结构，后面啥都跑不了 |
| **Stage 2** | MySQL -> PG 全量导入 + 逐表校验工具 | 没有数据，改了 SQL 也无法验证对不对 |
| **Stage 3** | DB adapter 兼容层（dialect 切换） | 不做这个，改一个 SQL 就要改一个文件两遍 |
| **Stage 4** | 12 个 service/task 的 SQL builder 迁移 | **核心工作**——把 MySQL 方言全部转成 PG 方言 |
| **Stage 5** | controller 回归 + 双库 parity 对比 | 光改了 SQL 不验证，切流后出问题无从定位 |
| **Stage 6** | 切流/回退演练 | 尚未开始 |

### 关键认知

- **12/12 个 SQL 模块已全部迁移完毕**（Stage 4 已收工）。最重的活已经做完，后面是收尾不是重新开始。
- **8 条真实双库 parity 已 PASS**（article 读链路、history 读写、comment 读链路、comment 写链路、collect 读写、user/auth 全链路、file/video 元数据、cleanOrphan 定时清理），每条都有落盘的 JSON 报告。
- **回归测试全量通过**（167 tests, 0 failures）。
- Stage 5 parity evidence 已覆盖总计划中列出的所有关键链路。
- Stage 6 切流演练是最后一步，工作量可控。

### 旧评估文档的更新说明

旧评估文档 `docs/04_项目优化沙盒推演/02_MySQL 到 PostgreSQL 迁移评估.md` 对 17 张表、手写 SQL、主要方言差异的判断仍然有效，但结论应从"暂不建议迁移"更新为"可并行验证、可回退地迁"。实际执行已经证明了这条路是可行的。

## Workspace And Baseline

- Active worktree: `/Users/yangdanping/Desktop/personal_project/coderx_server/.worktrees/phase2-pg-bootstrap`
- Branch: `phase2-pg-bootstrap`
- 当前 worktree 是刻意保留的迁移基线，包含大量既有未提交改动。
- 不要 reset、revert、清理“看起来无关”的 diff；应直接在当前状态上继续推进。

## 当前已经完成的事情

### 1. Stage 1 PostgreSQL 资产已经补齐到当前 worktree

`database/postgresql/` 下已经引入并核对过以下版本化资产：

- `README.md`
- `000_reset_data.sql`
- `001_schema.sql`
- `002_triggers.sql`
- `003_indexes.sql`
- `004_verify.sql`
- `import_mysql_dump_to_pg.py`

明确约束：

- `005_data_from_mysql_dump.sql` 没有引入，而且仍然不应该引入；它是环境相关、生成型数据文件，不应作为仓库资产同步。

### 2. Stage 2 Phase 2 工具链已经可用

现有脚本位于：

- `scripts/migration/phase2/bootstrap-pg.js`
- `scripts/migration/phase2/verify-parity.js`
- `scripts/migration/phase2/lib/runtime.js`
- `scripts/migration/phase2/lib/migrationUtils.js`
- `scripts/migration/phase2/README.md`
- `test/migration/phase2-utils.test.js`

这些脚本当前已经能完成：

- 从 MySQL 重刷 PostgreSQL 影子库
- 比对逐表行数
- 比对主键行缺失/多余
- 比对样本行内容
- 检查 PostgreSQL 侧外键孤儿
- 导入后重置 identity 序列

### 3. Stage 2 的 schema guard 已经实现并验证

这部分不再是 pending，已经完成：

- `scripts/migration/phase2/lib/migrationUtils.js`
  - 新增 `extractStage1TableNames(schemaSql)`
  - 新增 `findMissingTables(requiredTables, existingTables)`
  - 通过解析 `001_schema.sql` 提取 Stage 1 必需表集合
- `scripts/migration/phase2/lib/runtime.js`
  - 新增 Stage 1 schema 路径解析与必需表加载逻辑
  - `verifyParity()` 和 `bootstrapPostgresFromMySql()` 现在都会先做 fail-fast 校验
  - 如果 PostgreSQL 里缺少 Stage 1 必需表，会直接报错，而不是继续在空库/半成品 schema 上跑出误导性的结果

这轮修正后的关键行为是：

- 在发现 PG 缺表时，不会先去访问 MySQL
- `bootstrap` 路径在缺表时不会先建立 PG client 事务连接
- `scripts/migration/phase2/README.md` 已更新，明确声明 Stage 1 schema 是 Phase 2 的前置条件

### 4. Stage 3 数据库兼容层已经在位

当前 worktree 已包含数据库接入兼容层，核心位置包括：

- `src/app/config.js`
- `src/app/database.js`
- `src/app/database/`

它已经覆盖的方向包括：

- dialect 选择
- PG placeholder 适配
- mysql 风格结果封装
- 事务接口兼容

### 5. Stage 4 热点 SQL 迁移已经铺开

目前已有一批 service / task 迁移到成对的 `*.sql.js` helper 结构，包含但不限于：

- `src/service/article.service.js`
- `src/service/auth.service.js`
- `src/service/avatar.service.js`
- `src/service/collect.service.js`
- `src/service/comment.service.js`
- `src/service/history.service.js`
- `src/service/image.service.js`
- `src/service/oauth.service.js`
- `src/service/tag.service.js`
- `src/service/user.service.js`
- `src/service/video.service.js`
- `src/tasks/cleanOrphanFiles.js`

以及对应的：

- `src/service/article.sql.js`
- `src/service/auth.sql.js`
- `src/service/avatar.sql.js`
- `src/service/collect.sql.js`
- `src/service/comment.sql.js`
- `src/service/history.sql.js`
- `src/service/image.sql.js`
- `src/service/oauth.sql.js`
- `src/service/tag.sql.js`
- `src/service/user.sql.js`
- `src/service/video.sql.js`
- `src/tasks/cleanOrphanFiles.sql.js`

这部分已经覆盖过的典型迁移点包括：

- `RETURNING id` 取代 MySQL 风格 `insertId`
- `UPDATE ... FROM` 改写 MySQL `UPDATE ... INNER JOIN`
- 按方言切换 SQL builder
- `cleanOrphanFiles` 的 PG 时间函数兼容

### 6. Stage 5 最小验证面已经从 service 扩到多条 controller 读链路

当前 worktree 已经不止覆盖 `history.controller`，还新增并验证了以下 controller 回归：

- `test/controller/history.controller.test.js`
  - `addHistory`
  - `getUserHistory`
  - 非封禁内容 HTML 清洗与 50 字截断
  - 封禁文章标题/内容屏蔽为 `文章已被封禁`
- `test/controller/article.controller.test.js`
  - `getDetail`
    - 已登录详情读取
    - 匿名详情读取
    - history 写入失败不阻塞主响应
    - 封禁文章遮罩
  - `getList`
    - 列表内容清洗
    - 50 字截断
    - 封禁文章遮罩
    - `idList` 解析并透传给 service
    - 非法 `pageOrder` 回退到 `date`
- `test/controller/comment.controller.test.js`
  - `getCommentList`
    - 用户评论清洗/封禁遮罩
    - `getUserCommentList()` 返回 `null` 时的 fail path
    - 非法 `sort` 回退到 `latest`
    - 缺少 `articleId` 的失败返回
    - 文章评论分支异常兜底
  - `getReplies`
    - 空 `cursor` 归一为 `null`
    - 非正 `limit` 回退到 `10`
    - 显式 `cursor/limit` 透传
    - service 异常兜底

由于 TDD 暴露出真实行为缺口，当前 worktree 里已经做过几处最小生产修复：

- `src/controller/article.controller.js`
  - `getDetail()` 现在对任意 truthy `status` 做封禁遮罩，和列表/历史链路保持一致
  - `getList()` 现在会把非法 `pageOrder` 归一到 `date`
- `src/controller/comment.controller.js`
  - `getCommentList()` 现在会在 `getUserCommentList()` 返回 `null` 时提前失败，而不是在 `forEach` 里崩掉
  - `getReplies()` 现在会把非正 `limit` 归一到 `10`

额外说明：

- `test:migration:hotspots` 里的 glob 已改成带引号形式，降低不同 shell / 平台下的行为差异
- `test:migration:hotspots` / `test:migration:regression` 现在已经稳定包含 controller 回归
- `comment` 模块的 SQL/语法迁移主体已经接近完成；剩余工作更偏向 Stage 5 parity evidence 和 Stage 6 cutover / rollback 收尾，而不是继续大块改写 comment SQL

### 7. Stage 5 已开始落地 article 读链路 parity evidence

当前 worktree 新增了一条真正面向 Stage 5 的 parity evidence 工具链，位置包括：

- `scripts/migration/verify-article-read-parity.js`
- `test/migration/article-read-parity.test.js`
- `test/migration/scripts.test.js`

当前这条工具链的设计目标不是替代 controller 回归，而是补上“同数据集 MySQL vs PostgreSQL 读结果对比证据”。它当前已经覆盖：

- `article` 详情读取：`getDetail`
- `article` 列表读取：`getList` 的 `date` / `hot` 两种排序分支
- `article` 推荐读取：`getRecommendList`
- `article` 搜索读取：`search`

工具实现特点：

- 复用现有 `src/service/article.sql.js` builder，而不是另起一套 SQL
- MySQL / PostgreSQL 两端跑同一组 article 读查询后做归一化比对
- 当前 stop conditions 已显式落成脚本判断：
  - 结果条数不一致
  - 排序不一致
  - 结构/字段值不一致
- 已补齐两类容易误判 parity 的归一化细节：
  - MySQL JSON 字符串 vs PostgreSQL JSON/对象
  - MySQL datetime 字符串 vs PostgreSQL `Date`
- 即使通过 `--detail-ids` 指定详情样本，工具仍会尽量从详情结果里派生 `search` 关键词，避免 silently 丢掉搜索流
- 在真实双库跑数时，这条工具还帮助暴露并修正过两类问题：
  - PG article 查询返回的 camelCase alias 在运行时被折叠成小写
  - parity 工具对纯数字字符串的日期误判会污染报告

脚本入口：

- `pnpm run test:migration:phase5`
  - 现在会同时跑 Stage 5 article + history parity 工具的单测/契约测试
- `pnpm run migration:phase5:article-read -- ...`
  - 真正对接 MySQL / PostgreSQL 双库跑 article 读链路 parity evidence

说明：

- `test:migration:phase5` 是脚本与归一化逻辑测试，不是双库实跑
- 真正的同数据集 parity evidence 需要使用 `migration:phase5:article-read`
- `test:migration:regression` 现在已经把 `test:migration:phase5` 串进去，避免后续改动把这条验证面悄悄带坏

最新一轮真实双库 evidence：

- 已使用本机 MySQL + PostgreSQL 容器跑过 `migration:phase5:article-read`
- 结果为 `PASS`
- 报告文件已落到：
  - `docs/2026-04-06-article-read-parity-report.json`
- 当前样本覆盖：
  - 详情样本 `21, 22, 23, 39, 40`
  - 搜索关键词 `Vue知识点`

### 8. Stage 5 已开始落地 history 读写 parity evidence

当前 worktree 又新增了一条真正面向 Stage 5 的 `history` parity evidence 工具链，位置包括：

- `scripts/migration/verify-history-parity.js`
- `test/migration/history-parity.test.js`
- `test/migration/scripts.test.js`

这条工具链当前覆盖的目标不是再补一层薄 controller，而是把 `history` 里最容易在 MySQL -> PostgreSQL 迁移时出语义偏差的两类行为，显式转成 stop conditions：

- `getUserHistory`
  - 同一份数据集下，比较 MySQL / PostgreSQL 读结果
- `addHistory`
  - 对同一组 `(userId, articleId)` 做双次 UPSERT 证据校验
  - 检查两边最终计数是否一致
  - 检查同一 pair 是否异常膨胀成多行
  - 检查双端在两次写入后是否至少都真实持久化出一行，避免 `0 -> 0 -> 0` 这种 vacuous idempotency 被误判成通过

工具实现特点：

- 复用 `src/service/history.sql.js` 里的现有 SQL builder，而不是另起一套 SQL
- 复用 article parity 里的 `evaluateFlowParity()`，维持同一套 count/order/structure 对比语义
- 对 PG 未加引号 alias 被折叠成小写的问题，在 parity 工具侧做 key remap，而不是顺手改生产 SQL
- `getUserHistory` 的 parity 现在会先于 `addHistory` 写入证据执行，避免脚本自己刷新 `update_at` 后制造假失败
- 汇总 stop conditions 现在除了 `countMismatch / orderMismatch / structureMismatch`，还会显式报告 `missingPersistedRow`

脚本入口：

- `pnpm run migration:phase5:history -- ...`
  - 真正对接 MySQL / PostgreSQL 双库跑 `history` 读写 parity evidence

当前状态：

- 这条工具链的单测 / 契约测试已经补齐并通过
- `test:migration:phase5` 已经把它串进 Stage 5 聚合测试
- 已使用主仓库根目录 `.env.development` + 本地 PG password 跑过一次真实双库 evidence
- 结果为 `PASS`
- 报告文件已落到：
  - `docs/2026-04-06-history-parity-report.json`
- 当前样本覆盖：
  - `userId=8`
  - `articleId=65`

### 9. Stage 5 已开始落地 comment 读链路 parity evidence

当前 worktree 又新增了一条真正面向 Stage 5 的 `comment` read parity evidence 工具链，位置包括：

- `scripts/migration/verify-comment-read-parity.js`
- `test/migration/comment-read-parity.test.js`
- `test/migration/scripts.test.js`

这条工具链当前覆盖的目标不是继续堆一层薄 controller，而是把 `comment` 模块里读链路最容易在 MySQL -> PostgreSQL 迁移时出现语义偏差的几条真实 service-shaped 返回，显式转成 stop conditions：

- `getCommentList:latest`
  - 同一份数据集下，比较 MySQL / PostgreSQL 一级评论列表读取
  - 比较 service 组装后的 `replies` preview，而不是只比较顶层 SQL rows
- `getCommentList:hot`
  - 比较热门排序、reply preview、以及列表返回外壳
- `getReplies`
  - 比较回复列表
  - 比较 `replyCount`
  - 比较 `hasMore`
  - 比较 `nextCursor`

工具实现特点：

- 复用 `src/service/comment.sql.js` 里的现有 SQL builder，而不是另起一套 SQL
- 复用 article parity 里的 `evaluateFlowParity()`，维持同一套 count/order/structure 对比语义
- 默认采样现在会从 MySQL 里派生“有一级评论且该一级评论确实有回复”的 `(articleId, commentId)`，避免 `getReplies` 被空样本误导
- `getCommentList:*` 现在比较的是完整 service-shaped payload：`items + hasMore + nextCursor`
- 对 PG 未加引号 alias 被折叠成小写的问题，在 parity 工具侧做 key remap，而不是顺手改生产 SQL
- 对 PG 返回的字符串标识字段（如 `id/cid/rid`）在 parity 工具侧做最小归一化，避免把驱动返回类型差异误报成结构不一致
- MySQL 真实跑库路径现在优先走 `execute()`，避免 `LIMIT ?` 在 `query()` 插值下被带引号字符串污染，导致 parity 脚本自己制造 SQL parse error

当前状态：

- 这条工具链的单测 / 契约测试已经补齐并通过
- `test:migration:phase5` 已经把它串进 Stage 5 聚合测试
- 已使用主仓库根目录 `.env.development` + 本地 PG password 跑过一次真实双库 evidence
- 结果为 `PASS`
- 报告文件已落到：
  - `docs/2026-04-06-comment-read-parity-report.json`
- 当前样本覆盖：
  - `articleId=21`
  - `commentId=60`

### 10. Stage 5 已落地 comment 写链路 parity evidence

当前 worktree 新增了一条面向 Stage 5 的 `comment` write parity evidence 工具链，位置包括：

- `scripts/migration/verify-comment-write-parity.js`
- `test/migration/comment-write-parity.test.js`
- `test/migration/scripts.test.js`

这条工具链覆盖的目标是把 `comment` 模块里写链路最容易在 MySQL -> PostgreSQL 迁移时出现语义偏差的三条写入路径，显式转成 stop conditions：

- `addComment`
  - 双引擎各自 INSERT 一条一级评论
  - 双引擎各自用 `getCommentById` 读回
  - 比较归一化后的结构（排除 id/timestamps）
- `addReply:toComment`
  - 双引擎各自 INSERT 一条回复（指向现有一级评论，不含 reply_id）
  - 读回并比较
- `addReply:toReply`
  - 双引擎各自 INSERT 一条回复的回复（含 reply_id）
  - 读回并比较

工具实现特点：

- 复用 `src/service/comment.sql.js` 里的 `buildAddCommentSql`、`buildAddReplySql`、`buildGetCommentByIdSql`，而不是另起一套 SQL
- 处理 MySQL `insertId` 与 PG `RETURNING id` 的差异
- 对 PG 未加引号 alias 被折叠成小写的问题，在 parity 工具侧做 key remap
- 归一化比较时排除 `id`、`createAt`、`updateAt`（因为两端是各自插入，这些字段天然不同）
- 解析 MySQL JSON 字符串 vs PG JSON 对象，以及数值型字段的类型差异
- **所有插入的测试数据在 finally 块中自动清理**，不污染双端数据库
- 当不提供 `userId/articleId/commentId` 时，自动从 MySQL 采样一条"有一级评论且有回复"的锚点
- stop conditions 包含 `missingPersistedRow`（插入后读不回）和 `structureMismatch`（读回结构不一致）

脚本入口：

- `pnpm run migration:phase5:comment-write -- ...`
  - 真正对接 MySQL / PostgreSQL 双库跑 `comment` 写链路 parity evidence

当前状态：

- 这条工具链的单测 / 契约测试已经补齐并通过（7 tests）
- `test:migration:phase5` 已经把它串进 Stage 5 聚合测试
- 已使用主仓库根目录 `.env.development` + 本地 PG password 跑过一次真实双库 evidence
- 结果为 `PASS`
- 报告文件已落到：
  - `docs/2026-04-06-comment-write-parity-report.json`
- 当前样本覆盖：
  - 自动采样 `userId=2, articleId=21`
  - 3 条流：`addComment`, `addReply:toComment`, `addReply:toReply`
  - 测试数据已自动清理（mysql=3 pg=3）

### 11. Stage 5 已落地 collect 读写链路 parity evidence

当前 worktree 新增了一条面向 Stage 5 的 `collect` parity evidence 工具链，位置包括：

- `scripts/migration/verify-collect-parity.js`
- `test/migration/collect-parity.test.js`

这条工具链覆盖的目标是把 `collect` 模块里最容易在 MySQL -> PostgreSQL 迁移时出现语义偏差的读写路径，显式转成 stop conditions：

- `getCollectList`
  - 比较 MySQL `IF(COUNT(...), JSON_ARRAYAGG(...), NULL)` vs PG `CASE WHEN ... jsonb_agg(...)` 以及 `LIMIT ?,?` vs `LIMIT ? OFFSET ?`
- `getCollectArticle`
  - 比较 MySQL `JSON_ARRAYAGG` vs PG `jsonb_agg`
- `addCollect`
  - 双引擎各自 INSERT + 读回 + 归一化比较（排除 id/timestamps）
  - 处理 PG bigint 返回字符串的类型差异
  - 自动清理插入的测试数据

脚本入口：`pnpm run migration:phase5:collect`

当前状态：

- 7 个契约测试全部通过
- 已使用真实双库跑过一次 evidence
- 结果为 `PASS`
- 报告文件：`docs/2026-04-06-collect-parity-report.json`
- 样本：`userId=1, collectId=1`

### 12. Stage 5 已落地 user/auth 全链路 parity evidence

当前 worktree 新增了一条面向 Stage 5 的 `user/auth` parity evidence 工具链，位置包括：

- `scripts/migration/verify-user-auth-parity.js`
- `test/migration/user-auth-parity.test.js`

覆盖 6 条关键读链路：

- `checkStatus` — auth 中间件状态检查
- `getUserByName` — 登录用户名查找
- `getProfileById` — 用户个人资料（含文章/评论计数子查询）
- `getLikedById` — 用户点赞数据（`JSON_ARRAYAGG` vs `jsonb_agg`）
- `getFollowInfo` — 关注/粉丝数据（含复杂嵌套 JSON 构建）
- `findUserByEmail` — OAuth 邮箱关联查找

脚本入口：`pnpm run migration:phase5:user-auth`

当前状态：

- 5 个契约测试全部通过
- 已使用真实双库跑过一次 evidence
- 结果为 `PASS`
- 报告文件：`docs/2026-04-06-user-auth-parity-report.json`
- 样本：`userId=1 (ydp)`

### 13. Stage 5 已落地 file/video 元数据 parity evidence

当前 worktree 新增了一条面向 Stage 5 的 `file/video` 元数据 parity evidence 工具链，位置包括：

- `scripts/migration/verify-file-meta-parity.js`
- `test/migration/file-meta-parity.test.js`

覆盖 2 条读链路：

- `getArticleImages` — 文章图片列表（含 image_meta JOIN）
- `getArticleVideos` — 文章视频列表（含 video_meta JOIN）

工具特点：
- 处理 MySQL `tinyint(1)` `is_cover` 返回 0/1 vs PG `boolean` 返回 true/false 的归一化

脚本入口：`pnpm run migration:phase5:file-meta`

当前状态：

- 4 个契约测试全部通过
- 已使用真实双库跑过一次 evidence
- 结果为 `PASS`
- 报告文件：`docs/2026-04-06-file-meta-parity-report.json`
- 样本：`articleId=22`

### 14. Stage 5 已落地 cleanOrphanFiles 定时清理 parity evidence

当前 worktree 新增了一条面向 Stage 5 的 `cleanOrphanFiles` parity evidence 工具链，位置包括：

- `scripts/migration/verify-clean-orphan-parity.js`
- `test/migration/clean-orphan-parity.test.js`

覆盖 2 条关键查询：

- `findOrphanFiles:image` — MySQL `TIMESTAMPDIFF` / `DATE_SUB` vs PG `EXTRACT(EPOCH FROM ...)` / `INTERVAL`
- `findOrphanFiles:video` — 同上

脚本入口：`pnpm run migration:phase5:clean-orphan`

当前状态：

- 4 个契约测试全部通过
- 已使用真实双库跑过一次 evidence
- 结果为 `PASS`
- 报告文件：`docs/2026-04-06-clean-orphan-parity-report.json`
- 样本：`threshold=0 SECOND`

## 最近一轮已验证通过的内容

最近一轮迁移回归已经至少覆盖并通过：

- `pnpm run test:migration:regression` — **167 tests, 0 failures**
  - `test:migration:phase2` — 9 tests
  - `test:database:stage3` — 8 tests
  - `test:migration:hotspots` — 105 tests
  - `test:migration:phase5` — 45 tests
- 8 条真实双库 parity evidence 全部 `PASS`：
  - `migration:phase5:article-read` → `docs/2026-04-06-article-read-parity-report.json`
  - `migration:phase5:comment-read` → `docs/2026-04-06-comment-read-parity-report.json`
  - `migration:phase5:comment-write` → `docs/2026-04-06-comment-write-parity-report.json`
  - `migration:phase5:history` → `docs/2026-04-06-history-parity-report.json`
  - `migration:phase5:collect` → `docs/2026-04-06-collect-parity-report.json`
  - `migration:phase5:user-auth` → `docs/2026-04-06-user-auth-parity-report.json`
  - `migration:phase5:file-meta` → `docs/2026-04-06-file-meta-parity-report.json`
  - `migration:phase5:clean-orphan` → `docs/2026-04-06-clean-orphan-parity-report.json`

说明：
- 当前 worktree 仍然没有自己的 `.env*`
- 后续接手时如果 shell 里没有现成 `PG*` 变量，依旧建议沿用 `--env-file ... --pg-password ...` 的显式方式执行

其中 `pnpm run test:migration:regression` 当前会串行执行：

```bash
pnpm run test:migration:phase2
pnpm run test:database:stage3
pnpm run test:migration:hotspots
pnpm run test:migration:phase5
```

## 当前停点

**Stage 5 已于 2026-04-06 全部完成。**

- Stage 1 PostgreSQL 资产：已完成
- Stage 2 schema guard + Phase 2 tooling：已完成
- Stage 3 DB adapter 兼容层：已完成
- Stage 4 主要 SQL hotspot 迁移：已完成（12/12 模块）
- Stage 5 最小验证面：**已完成**（8 条 parity evidence 工具链全部 PASS，167 tests）
  - controller 回归覆盖：`history`, `article`, `comment`
  - 8 条 parity evidence 工具链全部 PASS（覆盖总计划列出的所有关键链路）
  - 回归测试：167 tests, 0 failures
- Stage 6 切流与回退演练：**尚未开始**

Stage 5 parity evidence 覆盖汇总：
- 登录/注册 → `user-auth` (6 flows)
- 文章列表/详情 → `article-read` (5 flows)
- 评论树 → `comment-read` (3 flows) + `comment-write` (3 flows)
- 浏览历史 UPSERT → `history` (2 flows)
- 收藏/关注 → `collect` (3 flows)
- 文件与视频元数据 → `file-meta` (2 flows)
- 定时清理任务 → `clean-orphan` (2 flows)

## 剩余任务清单

### A. ~~继续完成 Stage 5~~ ✅ 已完成

Stage 5 已于 2026-04-06 全部完成，8 条 parity evidence 工具链全部 PASS。
详见上方"Stage 5 parity evidence 覆盖汇总"。

### B. 把当前 worktree 整到 merge-ready（当前最高优先级）

1. 准备后续合并/PR 时，按阶段组织改动说明：
  - Stage 1 assets
  - Stage 2 tooling/schema guard
  - Stage 3 adapter
  - Stage 4 SQL helpers
  - Stage 5 tests/regression + parity evidence
2. 在准备 merge/PR 之前，至少重跑：
  - `pnpm run test:migration:phase2`
  - `pnpm run test:database:stage3`
  - `pnpm run test:migration:hotspots`
  - `pnpm run test:migration:phase5`
  - `pnpm run test:migration:regression`
3. 最终回归确认：167 tests, 0 failures

### C. 达到 cutover-ready（Stage 6）

1. 在 staging 完成一次完整 rehearsal：
  - 全量导入
  - 应用切到 PG
  - 冒烟
  - 切回 MySQL
2. 写出并验证 rollback runbook：
  - 切流前备份
  - 停写/只读窗口
  - bootstrap / verify steps
  - 健康检查
  - rollback trigger
3. 只有在 Stage 5 parity evidence 和 Stage 6 rehearsal 都通过后，才考虑真正切 `DB_DIALECT=pg`

### 当前不建议优先做的事

- 不要优先在低 ROI 的薄包装 controller 上“为了覆盖率而补测试”
- 不要做与迁移目标无关的重构
- 不要回退当前 dirty baseline
- 不要引入 `database/postgresql/005_data_from_mysql_dump.sql`

## 推荐起手任务

- **优先级最高：把 worktree 整到 merge-ready，准备 PR**
  - 重跑完整回归套件确认 0 failures
  - 组织 commit 说明（Stage 1–5 分阶段）
  - 创建 PR
- 然后：推进 Stage 6 cutover rehearsal
  - 在 staging 完成一次完整 rehearsal（全量导入 → 切 PG → 冒烟 → 切回 MySQL）
  - 编写并验证 rollback runbook

## 约束

- 继续使用同一个 worktree：`/Users/yangdanping/Desktop/personal_project/coderx_server/.worktrees/phase2-pg-bootstrap`
- 不要回退当前 dirty baseline 中的既有迁移工作
- 不要引入 `database/postgresql/005_data_from_mysql_dump.sql`
- 继续优先走 TDD 和最小改动
- Stage 5 parity 已完成，下一步目标优先是 merge-ready 和 Stage 6 rehearsal
- 除非测试确实暴露 bug，否则尽量不要顺手改无关生产代码
- 每完成一个有意义的里程碑，都同步更新这份 handoff 文档

## 下一位 Agent 接手时的执行上下文

接手这个 worktree 时，直接基于以下事实继续推进，不要把停点回退到更早阶段重新判断：

### 当前状态

- Stage 1 PostgreSQL assets under `database/postgresql/` are already imported
- `005_data_from_mysql_dump.sql` is intentionally excluded
- Stage 2 Phase 2 tooling exists under `scripts/migration/phase2`
- Stage 2 schema guard is already implemented and tested
- Stage 3 DB adapter compatibility layer is already in place
- Many Stage 4 runtime hotspots are already migrated via `*.sql.js` helpers
- Stage 5 parity evidence **全部完成**，8 条工具链覆盖所有关键读写链路：
  - `verify-article-read-parity.js` → `getDetail`, `getList(date/hot)`, `getRecommendList`, `search` → **PASS**
  - `verify-comment-read-parity.js` → `getCommentList:latest/hot`, `getReplies` → **PASS**
  - `verify-comment-write-parity.js` → `addComment`, `addReply:toComment`, `addReply:toReply` → **PASS**
  - `verify-history-parity.js` → `getUserHistory`, `addHistory` double-upsert → **PASS**
  - `verify-collect-parity.js` → `getCollectList`, `getCollectArticle`, `addCollect` → **PASS**
  - `verify-user-auth-parity.js` → `checkStatus`, `getUserByName`, `getProfileById`, `getLikedById`, `getFollowInfo`, `findUserByEmail` → **PASS**
  - `verify-file-meta-parity.js` → `getArticleImages`, `getArticleVideos` → **PASS**
  - `verify-clean-orphan-parity.js` → `findOrphanFiles:image`, `findOrphanFiles:video` → **PASS**
- Stage 5 controller regression surface covers: `history`, `article`, `comment`
- 回归测试：**167 tests, 0 failures**
- 所有 parity 报告已落盘至 `docs/2026-04-06-*-parity-report.json`
- 下一步：merge-ready → Stage 6 cutover rehearsal

### 已验证通过

- 回归套件：`pnpm run test:migration:regression` — **167 tests, 0 failures**
- 阶段套件：
  - `pnpm run test:migration:phase2`
  - `pnpm run test:database:stage3`
  - `pnpm run test:migration:hotspots`
  - `pnpm run test:migration:phase5`
- 真实双库 parity evidence（全部 PASS）：
  - `pnpm run migration:phase5:article-read`
  - `pnpm run migration:phase5:comment-read`
  - `pnpm run migration:phase5:comment-write`
  - `pnpm run migration:phase5:history`
  - `pnpm run migration:phase5:collect`
  - `pnpm run migration:phase5:user-auth`
  - `pnpm run migration:phase5:file-meta`
  - `pnpm run migration:phase5:clean-orphan`

### 优先继续方向

- **最高优先级：把 worktree 整到 merge-ready，创建 PR**
- 然后推进 Stage 6 cutover rehearsal（staging 全量导入 → 切 PG → 冒烟 → 切回 MySQL）
- 编写并验证 rollback runbook
- 只有 Stage 5 parity + Stage 6 rehearsal 都通过后才考虑切 `DB_DIALECT=pg`

### 执行要求

- Keep using TDD and minimal changes
- Treat the current dirty worktree as the correct baseline
- Do not revert unrelated files
- Update `docs/2026-04-05-pg-migration-handoff.md` after each meaningful milestone
- Re-run focused + aggregate regression commands after each behavior change
- Do an independent spec/quality review after each substantial step

### 硬约束

- Do not introduce `database/postgresql/005_data_from_mysql_dump.sql`
- Keep scope limited to advancing Stage 5/Stage 6 readiness
