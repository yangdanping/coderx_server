# Flow 发布与草稿版本

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

上线顺序为后端、前端，需配套发布。旧前端未提供 `draft` 会被拒绝；新前端不能搭配旧后端。无需数据库迁移。

前端的草稿缓存读写、清理共用同名 [Web Locks](https://www.w3.org/TR/web-locks/) 锁。浏览器无法提供该锁时，发布成功后保留共享缓存并提示清理失败，编辑器仍可继续使用。上线后刷新已有页面，以让所有标签页使用同一缓存协议。

数据库回归：`node --test test/integration/flowMedia.postgres.test.js`。此测试只允许本机 PostgreSQL，在临时 schema 中建表并在结束时删除该 schema。不要将完整 `test:media-db` 当作这项修复的隔离验证，它还包含其他使用应用表的测试。

## 发布权限（2026-09-30）

`POST /flow` 依次经过媒体维护检查、JWT 认证、账号当前封禁状态检查，再进入创建事务。封禁检查复用文章发布的 `verifyStatus`，已签发且仍有效的 JWT 不能绕过后续封禁。

封禁响应沿用文章的业务格式：HTTP 200，`{"code":-1,"msg":"您已被封禁"}`。客户端应检查 `code` 并展示 `msg`，保留当前正文和附件。`GET /flow` 与 `GET /flow/:id` 继续公开读取。

权限回归：`node --test --test-concurrency=1 test/controller/flow.router.test.js`。测试使用真实 Koa 路由、RSA JWT 和认证/封禁中间件，仅替换账号状态查询与创建操作，不连接业务表。

## 真实链路验收（2026-10-04）

在仅复制表结构的独立临时数据库中，使用正式注册和登录、真实 Koa 路由和本地图片存储完成浏览器验收：上传 PNG/JPEG、调整图片顺序、保存并刷新恢复、发布、详情及原图预览均通过。上传入口注入一次 503 后可重试；发布事务提交后主动丢弃响应，再用相同请求 ID 重试，只返回原动态，另一页随后保存的新草稿保持完整。

两个实际标签页验证旧草稿版本发布返回 409；真实用户表修改封禁状态后，已有 JWT 的发布返回 `code: -1`，未新增动态或消费草稿。

本轮后端相关 24 个文件、231 个测试通过。另在专用测试数据库运行 `flowMedia.postgres.test.js` 与 `flowImageLifecycle.postgres.test.js`，15 个测试通过；后者访问应用表，不能直接拿默认业务数据库运行。测试数据库和临时图片在验收后清理。

本机当前配置为 local，R2 凭据未配置。本次通过结论仅覆盖 local，实际启用 R2 的发布环境仍需补齐端到端验收。前后端完整验收和配套发布步骤见前端仓库 `FLOW_RELEASE.md`。
