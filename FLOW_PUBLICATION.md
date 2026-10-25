# Flow 发布与草稿版本

更新：2026-10-25。本文维护当前协议与部署边界。

`POST /flow` 必须显式提供 `draft`，与 `clientRequestId`、`content`、`mediaIds` 一起提交：

```json
{
  "clientRequestId": "4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf",
  "content": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "新的 Flow" }] }] },
  "mediaIds": [],
  "draft": { "id": 18, "version": 4 }
}
```

- 从保存的草稿发布：提供最后恢复或保存得到的 `id` 和 `version`，两者均须为正安全整数。正文允许包含尚未保存的编辑。
- 独立发布：提供 `draft: null`。这不会查找或消费账号的其他草稿，附件必须尚未关联任何草稿、文章或 Flow。
- 缺少 `draft` 或结构非法：拒绝请求。指定草稿不存在、不属于当前用户、不是 active Flow 草稿或版本已变化：返回 HTTP 409，回滚创建与附件绑定。
- 成功时由服务端在同一事务内消费指定草稿。前端只重置本地编辑状态，不再查询或删除远端草稿；其他标签页后来写入的本地缓存应保留。
- 网络失败后用相同 `clientRequestId` 重试相同正文、附件和草稿引用。已成功的请求会返回原 Flow，不再消费后来创建的草稿。保存或编辑改变请求内容后，使用新请求 ID。

上线顺序为后端、前端，需配套发布。旧前端未提供 `draft` 会被拒绝；新前端不能搭配旧后端。当前草稿版本安全修复没有新增迁移，但首次部署 Flow 的环境必须先具备草稿类型字段、Flow 表及相关索引，不能将“无新增迁移”理解为任意旧环境都能直接上线。

前端的草稿缓存读写、清理共用同名 [Web Locks](https://www.w3.org/TR/web-locks/) 锁。浏览器无法提供该锁时，发布成功后保留共享缓存并提示清理失败，编辑器仍可继续使用。上线后刷新已有页面，以让所有标签页使用同一缓存协议。

数据库回归：`node --test test/integration/flowMedia.postgres.test.js`。此测试只允许本机 PostgreSQL，在临时 schema 中建表并在结束时删除该 schema。不要将完整 `test:media-db` 当作这项修复的隔离验证，它还包含其他使用应用表的测试。

## 发布权限（2026-09-30）

`POST /flow` 依次经过媒体维护检查、JWT 认证、账号当前封禁状态检查，再进入创建事务。封禁检查复用文章发布的 `verifyStatus`，已签发且仍有效的 JWT 不能绕过后续封禁。

封禁响应沿用文章的业务格式：HTTP 200，`{"code":-1,"msg":"您已被封禁"}`。客户端应检查 `code` 并展示 `msg`，保留当前正文和附件。`GET /flow` 与 `GET /flow/:id` 继续公开读取。

权限回归：`node --test --test-concurrency=1 test/controller/flow.router.test.js`。测试使用真实 Koa 路由、RSA JWT 和认证/封禁中间件，仅替换账号状态查询与创建操作，不连接业务表。

## 当前验收与部署边界（2026-10-21）

- 首版已于 2026-10-05 配套上线；当前协议继续使用明确草稿引用、版本冲突和幂等请求 ID。
- 本轮验收源码为后端 `23cdb97`：763 项单元测试、21 项 PostgreSQL 集成测试、真实 FFmpeg 封面回归通过；依赖审计为 0 漏洞。这是当次结果，后续变更需重新验证。
- 独立测试环境通过文章图片/视频上传、草稿恢复与发布，Flow 排序、草稿恢复、重试去重、409 冲突和封禁保护；真实 Windows Ollama 流式回复及前端 AI 恢复通过。
- 前后端已整合并推送 `main`，整合时两仓库均只保留该分支。**仓库同步不等于生产部署**：本轮没有部署生产后端，也没有向生产写入测试内容。
- 手机实机、真实照片和本人账号长期使用仍待验收。完整覆盖与剩余工作见[前端阶段说明](https://github.com/yangdanping/coderx/blob/main/FLOW_RELEASE.md)。

本次纳入版本管理的 [历史草稿 SQL](./migrations/prerequisites/2026-08-11-draft-type.sql) 内容未改，没有新增编号迁移。2026-10-21 只读核对时生产代码为 `1eb6d15`，本地与生产 232 个列定义一致，关键 Flow 唯一约束和检查约束均存在。本地有 112 个索引、生产 106 个：差异包括 6 个非唯一草稿索引以及 `file_draft_id_idx` 的谓词；本轮未据此执行 DDL。

首次部署需先取得基础 Schema，再按目标库的实际结构确认历史草稿前置脚本和 `012_create_flow_post.sql` 是否已应用；已应用的环境不得重复执行。第一份 SQL 替换文章草稿唯一索引，旧代码与新索引不兼容。涉及迁移的部署需停写、备份并核对回退方案；已有新业务写入后不能恢复旧备份覆盖新数据。详见[数据库迁移说明](./migrations/README.md)。

首次上线前的临时状态与验收证据已归入[历史记录](./docs/history/flow-first-release-2026-10.md)。维护者本地完整证据在前端 `docs/verification/final-2026-10-21/`，被 Git 忽略，不随仓库分发。
