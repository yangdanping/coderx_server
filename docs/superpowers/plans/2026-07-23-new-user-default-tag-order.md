# New User Default Tag Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让尚未保存个性化标签顺序的登录用户默认看到“人工智能”排在“综合”之后第一位。

**Architecture:** 保留现有 `user_tag_preference` 数据模型，只在用户标签顺序查询中为没有 `sort_order` 的标签增加确定性回退顺序。已有偏好继续由 `sort_order` 决定；游客使用的全局标签查询不变。

**Tech Stack:** Node.js、Koa、PostgreSQL、node:test

## Global Constraints

- “综合”仍由前端硬编码，不进入后端标签排序。
- 已保存的用户自定义顺序不得被覆盖。
- 游客标签顺序不得变化。
- 不修改标签 ID，不新增数据库字段，不写入或回填偏好数据。

---

### Task 1: 为无偏好用户增加“人工智能”优先的查询回退

**Files:**
- Modify: `test/service/tag.service.test.js:69-87`
- Modify: `src/service/sql/tag.sql.js:13-21`

**Interfaces:**
- Consumes: `tagService.getUserTagOrder(userId)` 与现有 `user_tag_preference.sort_order`
- Produces: `buildGetUserTagOrderSql()` 返回带无偏好回退规则的 PostgreSQL 查询

- [ ] **Step 1: 写入失败的 SQL 合约断言**

在 `getUserTagOrder: reads the current user ordered list` 测试中加入：

```js
assert.match(
  calls[0].statement,
  /ORDER BY\s+utp\.sort_order ASC NULLS LAST,[\s\S]*CASE\s+WHEN utp\.sort_order IS NULL AND t\.name = '人工智能'\s+THEN 0 ELSE 1 END ASC,[\s\S]*t\.id ASC;/i,
);
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
node --test test/service/tag.service.test.js
```

Expected: `getUserTagOrder: reads the current user ordered list` 失败，错误显示当前 SQL 不包含 `CASE ... 人工智能 ...` 回退排序。

- [ ] **Step 3: 写入最小实现**

将 `buildGetUserTagOrderSql()` 的排序改为：

```js
function buildGetUserTagOrderSql() {
  return `
    SELECT t.id, t.name
    FROM tag t
    LEFT JOIN user_tag_preference utp
      ON utp.tag_id = t.id
     AND utp.user_id = ?
    ORDER BY
      utp.sort_order ASC NULLS LAST,
      CASE
        WHEN utp.sort_order IS NULL AND t.name = '人工智能' THEN 0
        ELSE 1
      END ASC,
      t.id ASC;
  `;
}
```

- [ ] **Step 4: 运行相关测试并确认通过**

Run:

```bash
node --test test/service/tag.service.test.js
```

Expected: 标签服务测试全部通过，失败数为 0。

- [ ] **Step 5: 运行后端完整测试**

Run:

```bash
npm test
```

Expected: 全部测试通过，失败数为 0。

- [ ] **Step 6: 提交实现**

```bash
git add src/service/sql/tag.sql.js test/service/tag.service.test.js
git commit -m "fix(tags): default new users to AI first"
```

### Task 2: 部署并验证本地与远程实际排序

**Files:**
- Deploy: `src/service/sql/tag.sql.js`
- Verify: local PostgreSQL `coderx`
- Verify: remote PostgreSQL `coderx`

**Interfaces:**
- Consumes: Task 1 提交后的 `buildGetUserTagOrderSql()`
- Produces: 本地与生产环境一致的新用户默认标签顺序

- [ ] **Step 1: 本地验证无偏好用户和已有偏好用户**

通过项目数据库连接执行 `buildGetUserTagOrderSql()`：

```js
const sql = buildGetUserTagOrderSql().replace('?', '$1');
const noPreferenceRows = await client.query(sql, [13]);
const personalizedRows = await client.query(sql, [1]);
```

Expected:

- 本地无偏好 Google 用户 ID 13 的第一项是“人工智能”。
- 本地已有完整偏好的用户 ID 1 仍以其 `sort_order = 0` 的标签开头。

- [ ] **Step 2: 核对生产文件并创建精确备份**

Run:

```bash
ssh aws-t4g-migration \
  'sudo -n sha256sum /root/coderx_server/src/service/sql/tag.sql.js; sudo -n git -C /root/coderx_server status --short'
ssh aws-t4g-migration \
  'sudo -n cp /root/coderx_server/src/service/sql/tag.sql.js /home/admin/tag.sql.js.before-codex && sudo -n chown admin:admin /home/admin/tag.sql.js.before-codex'
```

Expected: 远程文件存在；备份成功；若远程该文件已有未提交修改，则停止部署并先解决差异。

- [ ] **Step 3: 上传实现并只重启 Koa 服务**

Run:

```bash
scp src/service/sql/tag.sql.js aws-t4g-migration:/home/admin/tag.sql.js.codex-upload
ssh aws-t4g-migration \
  'sudo -n install -m 0644 /home/admin/tag.sql.js.codex-upload /root/coderx_server/src/service/sql/tag.sql.js && sudo -n pm2 restart coderx_koa_server --update-env'
```

Expected: `coderx_koa_server` 状态为 `online`。

- [ ] **Step 4: 远程验证无偏好与已有自定义顺序**

通过生产项目依赖和 `.env.production` 执行同一查询。

Expected:

- 远程无偏好 Google 用户 ID 11 的第一项是“人工智能”。
- 远程已有完整偏好的 Google 用户 ID 10 仍以“人工智能”开头，且后续顺序与保存的 `sort_order` 一致。
- `GET /tag/order` 所使用的服务进程已加载新查询。

- [ ] **Step 5: 核对部署文件并清理中转文件**

Run:

```bash
shasum -a 256 src/service/sql/tag.sql.js
ssh aws-t4g-migration \
  'sudo -n sha256sum /root/coderx_server/src/service/sql/tag.sql.js; unlink /home/admin/tag.sql.js.codex-upload; unlink /home/admin/tag.sql.js.before-codex'
```

Expected: 本地与远程文件 SHA-256 一致，中转文件已清理。
