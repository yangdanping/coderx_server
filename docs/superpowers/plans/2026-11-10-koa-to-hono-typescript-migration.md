# Koa → Hono / JavaScript → TypeScript 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 迁移方向已经确认；默认在下一会话连续完成本地任务，不因常规阶段结束反复要求批准。子代理只在用户或适用技能明确要求时使用。

**Goal:** 在当前 Git 仓库完成保持接口兼容的 Hono + TypeScript 迁移，交付可构建、可测试、可独立部署的候选版本和蓝绿发布方案。

**Architecture:** 保留 Node.js、PostgreSQL、Service/SQL 分层、Socket.IO、媒体及采集能力。先建立短期 JS/CommonJS 兼容边界与 Hono 入口，逐模块迁移，最终收敛到严格 TypeScript + ESM；应用构建与进程启动、定时任务分离。线上采用独立 release 目录、端口和 PM2 进程，由 Nginx 切流，实际生产操作另行授权。

**Tech Stack:** Node.js、pnpm、Hono、`@hono/node-server`、TypeScript 7、tsx、Zod、`node:test`、pg、Socket.IO、Redis、PM2；保留现有 AI SDK、S3/R2、Sharp/Jimp/FFmpeg、node-cron。

## Global Constraints

- 用户于 2026-11-10 决定开始迁移，在下一会话实施；`HONO_MIGRATION.md` 的旧暂缓决定已被替代。
- 不新建业务项目、不重建 Git、不丢历史。复用合适 checkout；默认分支 `codex/hono-typescript-migration`，已有适合分支则复用。确实需要新 worktree 时使用平台 `create_worktree`。
- 保留 `xxx.service.ts`、`xxx.controller.ts`、`xxx.router.ts`、`xxx.middleware.ts`、`xxx.sql.ts` 命名；不引入 NestJS、装饰器或重排全部业务目录。
- 最终全部 `src` 运行时代码迁入 TS。`allowJs`、CJS 桥和 Koa 对照入口只是过渡，不能永久以 `any` 包装 JS 后宣称完成。
- 保持 URL、方法、请求字段、HTTP 状态、业务 code、返回字段、JWT、权限、媒体 URL 和通知事件兼容。Zod 不得无意收紧旧接口已接受的有效输入。
- 本次不全面更换 JWT、日志、ORM、Socket.IO 协议或 Node 运行时，不增加前端 RPC/OpenAPI 等无关改造。
- 新候选 HTTP 默认不创建/启动清理或采集任务；独立任务进程与生产任务归属需要明确。
- 下一会话可修改本地源码、依赖、锁文件、测试、构建及部署材料；不自行 push、合并 main、部署、重启线上、改线上 Nginx、切流或操作生产数据库/媒体/密钥。
- PG 集成测试只能使用已确认可丢弃的测试库。localhost 和 development 模式均不能证明数据库可丢弃；媒体、R2、Redis 通道和测试密钥也必须隔离。
- 外部条件不足时继续其他独立工作，记录未执行检查；不得把 mock、跳过检查或示例配置称为线上验证。

## 1. 基线与执行记录

本文文件路径相对于仓库根 `/Users/yangdanping/Desktop/personal_project/coderx_server`，换 checkout 后以实际根目录为准。

规划时分支 `main`、HEAD `28a693d`。本会话只编写计划、更新决定/导航及精确 Git ignore 例外；业务代码尚未迁移。下次执行先检查工作区并保留这些计划文件及用户其他改动。

| 规划时证据 | 结果与意义                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------- |
| 源码       | 166 个 JS 文件，约 19,791 行，均含 CJS 用法                                                 |
| HTTP       | 16 Router、16 Controller、10 Middleware；扫描的 88 处声明可能含注释，实施时重新登记实际端点 |
| Service    | 43 个业务/SQL 文件，没有直接使用 Koa ctx，可保留业务并补类型                                |
| 测试       | 123 个 JS 测试文件；默认脚本覆盖其中 115 个                                                 |
| 已运行基线 | Node 26.12.1 下 763 pass / 0 fail；未运行真实 PG 集成测试；下次必须重跑                     |
| CJS mock   | 56 个测试文件涉及 require 缓存/模块加载钩子，需与源码同步迁移                               |
| Node       | `.nvmrc` 为 22.22.2；engines 为 `^22.22.2                                                   |     | ^24.15.0 |     | >=26.0.0`；不能静默提高最低版本 |
| pnpm       | `12.11.2`，保留包管理器与锁文件                                                             |
| 生产环境   | 本会话未访问服务器，不能把历史端口/路径/资源记录当成实时事实                                |

执行 agent 持续更新此表与任务勾选；如需要续接，留下当前分支、验证证据和第一项未完成任务。

| 阶段                                   | 状态       | 验证命令及结果 | 提交/工作区证据  | 剩余条件               |
| -------------------------------------- | ---------- | -------------- | ---------------- | ---------------------- |
| Task 0：契约与基线                     | 已完成，按用户要求暂停 | Node v26.12.1 / pnpm 12.11.2；基线 763/763；HTTP 12/12；最终默认测试 775/775 | codex/hono-typescript-migration，基于 28a693d；本地未提交 | 下一次继续时从 Task 1 开始 |
| Task 1：工具链与兼容入口               | 已完成     | type-check / build 通过；test 775/775；test:hono 3/3；frozen install 通过 | 保留 Task 0，当前分支本地未提交 | 下一项 Task 2；Node 22 运行待验 |
| Task 2：副作用边界                     | 完成       | 类型/构建通过；Hono 27/27、原有 775/775；范围审查通过 | 本地未提交，保留 Task 0–1 工作区 | Node 22 与真实外部服务集成待验 |
| Task 3A：应用工厂与基础 HTTP 行为     | 完成，按约定暂停 | 类型/构建通过；Hono 39/39、原有 775/775；范围复审通过 | 保留 Task 0–2 与用户改动，本地未提交 | 下一项 3B；Task 3 整体仍未完成 |
| Task 3B：解析、错误与日志               | 完成，按约定暂停 | 类型/构建通过；Hono 57/57、原有 775/775；范围复审通过 | 保留 Task 0–3A 与用户改动，本地未提交 | 下一项 3C；Task 3 整体仍未完成 |
| Task 3C：认证、权限与 AI 限流           | 完成，Task 3 本地验收通过 | 类型/构建通过；Hono 73/73、原有 775/775；独立复审通过 | 保留 Task 0–3B 与用户改动，本地未提交 | 下一项 Task 4；真实业务装配与外部集成待验 |
| Task 4A：标签 JSON 链路               | 完成，按约定暂停 | 类型/构建通过；Hono 98/98、原有 775/775；独立复审通过 | 原分支本地未提交，保留全部既有改动 | 下一项 4B，本次不进入；真实 PG/Node 22 待验 |
| Task 4B：图片上传解析                 | 完成，按约定暂停 | 类型/构建通过；Hono 110/110、旧套件 775/775；独立复审通过 | 原分支本地未提交，保留全部既有改动 | 下一项 4C，本次不进入；完整图片接口未完成 |
| Task 4C：图片业务链路 | 完成，按约定暂停 | 类型/构建通过；Hono 111/111、旧套件 776/776；独立复审 PASS / Approved | 原分支本地未提交，保留全部既有改动 | 下一项 4D，本次不进入；真实 PG/R2/Node 22 待验 |
| Task 4D：AI 流输出 | 完成，按阶段暂停 | 类型/构建通过；Hono 120/120、旧套件 776/776（别名修复后相关旧工具 6/6）；独立复审通过 | 原分支本地未提交，保留全部既有改动 | 下一项 4E；真实 AI/Node 22 待验 |
| Task 4E：AI 取消与整体验收 | 完成，Task 4 本地验收通过 | 类型/构建通过；Hono 128/128、旧套件 776/776；独立复审 PASS / Approved | 原分支本地未提交，保留全部既有改动 | 暂停，不进入 Task 5；真实集成与 Node 22 待验 |
| Task 5A：user、oauth | 完成，按约定暂停 | 类型/构建通过；Hono 146/146、旧套件 777/777；独立复审 PASS / Approved | 原分支本地未提交，保留全部既有改动 | 下一项 5B，本轮不进入；真实集成与 Node 22 待验 |
| Task 5B：tag/history/collect/notification | 完成，按约定暂停 | 类型/构建通过；Hono 175/175、旧套件 777/777；独立复审 PASS / Approved | 原分支本地未提交，保留全部既有改动 | 下一项 5C，本轮不进入；真实集成与 Node 22 待验 |
| Task 5C：comment/draft/article | 完成，按约定暂停 | Hono 194/194、旧套件 777/777，类型/构建通过，独立复审 PASS / Approved | 原分支本地未提交，保留全部既有改动 | 下一项 5D，真实集成与 Node 22 待验 |
| Task 5D：flow、flowDraft | 完成，按约定暂停 | Hono 199/199、旧套件 777/777，类型及构建通过，独立复审 PASS / Approved | 原分支本地未提交，保留既有改动 | 下一项 5E，真实集成与 Node 22 待验 |
| Task 5E：avatar、image、media、video、ai | 完成，Task 5 本地验收通过 | 85 条业务路由、Hono 219/219、旧套件 777/777，类型、构建及独立复审通过 | 原分支本地未提交，保留既有改动 | 下一项 Task 6，按约定暂停 |
| Task 6：媒体上传、读取和视频生命周期专项 | 完成，本地隔离验收通过 | Hono 227/227、旧套件 778/778、FFmpeg 2/2、隔离 PostgreSQL 15/15、独立复审通过 | 原分支本地未提交 | 本轮暂停，下一项 Task 7 |
| Task 7：业务、SQL、存储与工具严格类型化 | 完成，本地隔离验收通过 | Node 22 / 26 各 Hono 227/227、旧套件 781/781，隔离 PostgreSQL 20/20，独立复审通过 | 原分支本地未提交 | 本轮暂停，下一项 Task 8 |
| Task 8：Socket、采集、CLI 与独立清理 | 完成，本地隔离验收通过 | Node 22 / 26 各 1025/1025，临时 PostgreSQL 与 Redis 验证、独立复审通过 | 原分支本地未提交 | 本轮暂停，下一项 Task 9 |
| Task 9：ESM 与兼容层收敛 | 完成，本地隔离验收通过 | Node 22 / 26 各 886/886，临时 PostgreSQL 21/21，FFmpeg 各 2/2，无源码发布包与 Redis 验证通过 | 原分支本地未提交 | 本轮暂停，下一项 Task 10 |
| Task 10：发布材料与本地发布演练 | 完成，本轮暂停 | 类型、构建及 Node 26 全套 888/888，Node 22 定向 17/17，PM2/Nginx 隔离启停、健康检查和独立复审通过 | 原分支本地未提交，有本地演练制品 | 下一项 Task 11，真实发布环境待验 |
| Task 11：本地最终验收与交接 | 完成，本地验收通过 | Node 22/26 各 888/888，临时 PG 21/21，Redis、FFmpeg、无源码制品及独立复审通过 | 本地候选 task11-local-8cba3591e13f，工作区未提交 | Task 12 待授权验证目标环境 |
| Task 12：线上验证与切流 | 12A 目标机只读核查完成，隔离部署待确认 | 已核对运行版本、监听进程、工作目录、Git HEAD、媒体和 JWT 路径 | 本地迁移候选尚未提交，线上仍运行旧版 | 待确定候选提交及隔离环境，12B/12C 尚未执行 |

### 2026-11-11 Task 0 完成与交接

- 本次用户将范围明确缩小为 **完成 Task 0 后暂停**。Task 1–11 尚未开始；Task 12 仍未授权。
- 已先读本计划、`HONO_MIGRATION.md`、README、Flow/采集协议；仓库及其祖先目录未发现适用的 `AGENTS.md`。
- 从 `main` / `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 创建 `codex/hono-typescript-migration`，复用当前 checkout。开始时 `.gitignore`、`HONO_MIGRATION.md`、`docs/README.md` 已修改，本计划为未跟踪文件；保留这些用户改动，不 reset/clean。
- 工具版本实测：Node `v26.12.1`、pnpm `12.11.2`。尚未进行最低 Node 22、TS 类型检查或构建；TS 工具链属于 Task 1。
- 旧测试会导入配置并读取 JWT 文件，先增加仅供测试的隔离 preload：绕过 dotenv、以临时内存 RSA 密钥替代真实密钥、使用惰性 PG pool 的无效测试连接串、阻止外部连接及文件日志。
- 首次隔离基线有 7 项因缺 PG 占位配置而初始化失败，没有连接数据库；补齐无效占位 URL 后 `pnpm test`：**763 pass / 0 fail / 0 skipped**。未删除旧用例。factory 导入断言先失败，提取后定向检查通过。
- 尚无已确认可丢弃的 PG 测试库；未运行 `test:media-db`，未访问真实 R2、Redis、AI、OAuth、生产媒体或生产密钥。没有启动旧 `main.js`、push、合并或部署。
- 完成 `src/app/koaApp.js`，通过参数注入错误处理、日志和 CORS 配置；导入和构建不读取配置/密钥、不导入业务服务或 cron、不监听端口。旧 `src/main.js` 复用该 factory，仍由旧入口显式启动清理和 AI 健康检查，路由注册仍在原 listen 回调中。**新 Hono HTTP 默认禁用任务的实现属于后续 Task 2，本阶段尚未创建 Hono 入口。**
- `test/fixtures/http-contracts.json` 固定 **16 个 Router、85 条实际路由声明**，包含自动 HEAD、正则路径、输入、认证/封禁/权限顺序、业务响应、媒体和限流/维护说明。来源为实际 router/controller/middleware、常量和协议文档，测试逐项比较运行时注册栈，排除注释中的旧路由。
- `test/http/legacy.contract.test.js` 经真实 Koa/Node HTTP、路由、Controller、中间件和 AI SDK 流格式运行；Service 为 fake，上传/视频使用内存或临时目录，端口为 `127.0.0.1:0` 并在结束后关闭。成功与错误代表用例覆盖 JSON/JWT/封禁/权限/维护、multipart、AI SSE/限流、Range、Flow 动态路径/草稿/冲突、尾斜杠、HEAD/OPTIONS/405/Allow、畸形 JSON、重复 query、undefined 省略、OAuth Location/JWT。
- 保留已观测的旧行为：畸形 JSON 在认证前映射为生产格式 500；数字 Flow 详情不接受尾斜杠/前导零，`/flow/draft` 单独匹配；裸 JWT 仍被接受；重复 query 保留为数组。这些是后续迁移对照，未在 Task 0 顺便改变接口。
- `pnpm test` 已纳入 HTTP 契约测试和测试隔离 preload；直接执行 HTTP 测试也会加载隔离，避免绕过保护。测试中的图片字节/AI 内容/OAuth 用户/视频都是 fake，不能作为图像解码、模型、第三方身份、FFmpeg 或真实媒体生命周期集成通过的证据。
- 最终验证：`node --test --test-concurrency=1 test/http/legacy.contract.test.js` **12 pass / 0 fail / 0 skipped**；`pnpm test` **775 pass / 0 fail / 0 skipped**（约 15.2 秒）；`git diff --check` 通过。中途 HTTP 首轮因清单尚未生成失败 1 项，补齐清单后通过。预期错误路径会输出旧实现的 console 日志，未改动生产日志行为。
- Task 0 范围审查通过，未发现阻塞问题。原有 `.gitignore`、`HONO_MIGRATION.md`、`docs/README.md` 与开始时 SHA-256 一致；本计划仅追加进度和更新勾选。改动均留在当前分支工作区，未创建提交，HEAD 仍为 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`。
- **下一步是 Task 1：TS7 编译、测试和兼容入口。** 本次在 Task 0 完成后暂停。类型检查/构建、Node 22 验证、真实 PG/R2/Redis/AI/OAuth/FFmpeg 集成、部署材料及发布演练均未执行。发布仍须先完成 Task 1–11 和隔离集成验收，Task 12 另行授权；当前没有候选构建或上线结果。

### 2026-11-11 Task 1 完成与交接

- 用户在 Task 0 暂停后明确开始 Task 1；继续使用 `codex/hono-typescript-migration`，保留全部未提交的 Task 0 与用户改动，本阶段只实施工具链与兼容入口。
- 已重新查询 npm registry 并核对 [TS7 正式公告](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)、[Hono 稳定 release](https://github.com/honojs/hono/releases/tag/v4.13.17) 和 [Node adapter 文档](https://hono.dev/docs/getting-started/nodejs)。稳定版本：TypeScript `7.0.2`、Hono `4.13.17`、`@hono/node-server` `2.1.6`、`@hono/zod-validator` `0.9.1`、tsx `4.23.15`、`@types/node` 22 分支 `22.20.5`。
- Registry peer 条件：node-server 接受 Hono `^4 || ^5.0.0-0`；zod-validator 接受 Hono `>=4.11.2`、Zod `^3.25.0 || ^4.0.0`，与当前 Zod `4.6.5` 兼容。以上工具要求的 Node 下限均不高于本仓库最低版本 `22.22.2`，不更改 engines 或使用预发布包。
- 运行时仍为 Node `v26.12.1` / pnpm `12.11.2`；常见 nvm/Homebrew 路径未找到 Node 22，最低版本实际执行尚未验证。
- 新增 `tsconfig.json` / `tsconfig.build.json`，使用严格 NodeNext、ES2022、暂时 `allowJs: true` / `checkJs: false`；根 package 保持 CommonJS。`jsconfig.json` 改为继承同一配置，移除旧 `baseUrl`。build 只编译 src 到 dist，并启用 `noEmitOnError`。本阶段尚未将旧 JS 业务转换为严格 TS。
- 已按上述版本精确安装依赖和锁文件；另补齐实际缺失的 `@types/module-alias@2.0.4`、`@types/json-schema@7.0.15`、`@types/koa@3.0.3`、`@types/pngjs@6.0.5`，没有升级既有业务运行时依赖。锁文件新增各平台 TypeScript/esbuild 包及类型依赖，sharp 的 Node 类型 peer 改为 22 分支，运行时版本不变。
- 首次安装因 pnpm 拦截 esbuild 安装脚本而报告 `ERR_PNPM_IGNORED_BUILDS`；在 `pnpm-workspace.yaml` 仅加入 `allowBuilds.esbuild: true`，保留原有 overrides，随后 `pnpm install --frozen-lockfile` 通过，未出现 peer 警告。dotenv 的可选 agent skills 提示未作安装或批准操作。
- 严格检查暴露 happy-dom `20.14.5` 的声明兼容问题：其 `BrowserWindow.d.ts` 展开的 ReadableStream 构造签名引用 Node 26 的 `UnderlyingDefaultSource`，Node 22/24 类型没有此成员。曾试用 Node 24 类型，确认同样失败后恢复 **Node 22.20.5 类型**。以版本绑定的 pnpm 补丁 `patches/happy-dom@20.14.5.patch` 将该声明改为 `typeof ReadableStream`，与包源码的导入及赋值一致；没有修改第三方运行时代码、添加全局假声明或开启 skipLibCheck。补丁原因和移除条件见 `patches/README.md`，frozen install 已验证可应用。
- 新增 `src/main.hono.ts` 和 `src/hono.bootstrap.ts`：先读取 `APP_ENV_FILE`（未设置时沿用 NODE_ENV 对应 `.env.development` / `.env.production`），注册 `@` 为入口所在目录，再动态加载 Hono/Node adapter。显式指定的 env 文件不存在时启动失败；要求显式 `APP_PORT`，监听 `127.0.0.1`（测试用端口 0）。不导入旧配置、密钥、Service、路由或任务。**当前 Hono 入口仅返回默认 404，业务 API、readiness、完整配置与退出流程属于后续任务，不可作为替代生产 API 的发布制品。**
- 保留所有旧 dev/start 与默认测试命令，新增 `dev:hono`、`start:hono`、`type-check`、`build`、`test:hono`。新 TS 测试当前通过 `test:hono` 单独执行，尚未合入默认 test（按本阶段计划）。
- `test/http/toolchain.test.ts` 在临时 env 文件中提供端口 0，分别用 tsx 源码和纯 Node 编译产物启动 HTTP。在 bootstrap 加载时检查 env 已加载，`require.resolve` 的真实 alias 路径为 src/dist 各自的常量模块，并验证 dist 没有加载任何 src 模块或旧配置/业务/任务。另验证显式缺失 env 文件启动失败。子进程启动、HTTP 请求、退出均有超时和清理，测试结束关闭实际监听及删除临时目录。
- 验证证据：`pnpm exec tsc --version` → **7.0.2**；`pnpm type-check`、`pnpm build`、`pnpm install --frozen-lockfile` 均退出 0；`pnpm test` **775 pass / 0 fail / 0 skipped**（约 15.8 秒）；`pnpm test:hono` **3 pass / 0 fail / 0 skipped**；`git diff --check` 通过。检查 dist 仅含 JS 和 source map，没有 env、密钥、测试或 public 媒体文件。
- 反向验证：临时在 src 加入 number/string 类型错误后，type-check 和 build 均以 **TS2322 / exit 1** 拒绝；已移除临时文件并重新成功检查/构建。初始 smoke 因新入口/产物尚不存在失败，最终 source/dist/缺失 env 三项全部通过；未删除旧断言掩盖失败。
- Task 1 范围审查通过，没有阻塞项。Task 0 源码、测试以及原有 `.gitignore`、`HONO_MIGRATION.md`、`docs/README.md` 的 SHA-256 与本次开始时一致；package/lock 与本计划是有意追加的迁移改动。分支仍为 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，所有改动本地未提交。
- **下一项 Task 2：配置、存储路径和启动副作用隔离。** 本次未执行 Task 2–12，未 push/合并/部署/启动生产入口/操作业务数据库、媒体或密钥。Node 22 与真实外部服务集成仍待隔离环境验证；Hono/TS 全量迁移和发布条件尚未完成。

### 2026-11-11 Task 2 执行记录

- 用户开始 Task 2，复用 `codex/hono-typescript-migration` 并保留 Task 0–1 未提交内容。范围为配置、资源路径、清理任务创建边界与退出基础设施，尚不进入 Task 3 的业务 HTTP 外壳。
- 已核对 node-cron `4.6.0` 已安装源码：`schedule()` 调用 `createTask()` 后立即 `start()`；`scheduled: false` 不生效。将改用显式 factory / `createTask()`，关闭时不创建任务或加载生产清理依赖。对应[官方迁移说明](https://www.nodecron.com/migrating-from-v3.html)。
- **测试隔离失误记录：** 首次清理 factory 红灯命令 `node --import=tsx --test test/tasks/backgroundJobs.test.ts` 未预加载隔离，直接导入旧清理模块。日志确认加载 `.env.development`；旧配置同步读取默认 JWT 文件后才完成导出，因此该次不能宣称未读取真实配置/密钥。旧模块还初始化了惰性 PG pool、日志和 cron 定时器。进程约 23.9 秒后已终止，未继续运行。捕获日志没有 SQL 执行、清理启动/执行或网络错误记录，检查没有残留对应测试进程；这些证据不等同于独立外部服务审计。本次不会为核实而访问业务数据库或生产服务。
- 后续测试必须在导入旧模块之前应用隔离，清除新增密钥/env/任务环境变量的继承；运行时配置测试只使用显式临时路径和测试密钥。上述失误与相关失败保留记录，不以最终测试通过掩盖。
- **第二次隔离失误与纠正：** 给候选启动加入密钥读取后，临时密钥夹具的脚本修改发生 `StopIteration`，但后续链式测试仍执行，source/dist smoke 读取了默认密钥路径且通过；该通过结果不作为隔离验收证据，没有打印密钥内容。已停止该实现代理的运行操作，补充 `test/support/runtime-guard.js`：启动测试及子进程仅允许显式临时目录内的 env/密钥读取，阻止外部连接；现有 unit suite 继续使用原隔离 preload。保护自身以 fake 文件验证，修正后的 guarded suite 首轮 10/10 通过。后续补齐工作由新的实现代理在上述保护下完成，不能放宽保护来通过测试。
- 用户因额度不足选择验证、交接后暂停，随后明确恢复并继续 Task 2。恢复时已有配置解析、路径统一、清理 factory、退出基础设施和临时资源测试；重新运行 `pnpm type-check`、`pnpm build` 均通过，guarded `pnpm test:hono` 为 20/20，隔离 `pnpm test` 为 775/775。此轮通过仍不代表 Task 2 验收完成。
- 首轮独立审查发现四项必须修复的问题：任务停止失败/超时后 HTTP 监听仍开启；启动失败清理不受超时限制；采集入口忽略 `APP_ENV_FILE`；node-cron 已进入的异步回调可能在 stop 的在途集合快照后才开始执行。均已修复并补充针对性回归测试；复审要求加强监听关闭的实际断言后，也已补齐并通过，未进入 Task 3。

### 2026-11-11 Task 2 完成与交接

- 完成纯运行时配置解析和环境预加载：候选默认绑定 `127.0.0.1`，端口显式指定，后台任务开关仅接受 `true`/`false` 且默认关闭；支持计划中的 env、媒体、JWT、日志、构建标识和退出超时配置。兼容旧 `APP_HOST=http://127.0.0.1` 格式，非法主机配置错误不回显输入中的凭据。
- 媒体路径统一由 `MEDIA_ROOT` 派生 avatar/img/video，视频转码不再硬编码 `./public/video`。既有 localMediaCleanup、mediaRuntime、采集和库存/迁移 CLI 已引用共享常量，因此保留其业务实现；删除清理模块未使用的 `public` 路径元数据。LocalMediaStore 的符号链接、目录权限和所有权保护未放宽。
- 候选启动后保留配置指定的 JWT 密钥缓冲区，不生成运行密钥；旧配置改为按需读取密钥。source/dist smoke 使用临时 RSA 密钥、env、媒体/日志根目录，检查路径和密钥哈希、env/alias 初始化顺序及 dist 不回载 src。**这里指最终隔离复验结果；前两次误读真实配置/默认密钥的失误记录保留在上节，没有据此声称整个阶段未读取当前密钥。**
- 清理模块改为显式 factory；关闭时不加载清理依赖、不创建 cron、不调用 processPending；开启后才显式 start。停止会阻止新回调、等待已开始的任务并销毁 cron，覆盖 node-cron 已排队回调晚到的竞态。旧 Koa 入口仍显式拥有旧清理任务，新 HTTP 不导入采集 worker。既有清理 SQL、事务及 outbox 行为未重写。
- 退出基础设施支持幂等停止、任务排空、资源 close 回调与超时。信号及启动失败首先关闭 HTTP 监听；正常流程等待任务后关闭依赖资源；失败或超时由库回调报告，独立 CLI 以退出码 1 终止。临时子进程测试实际观察监听关闭，在停止仍挂起及失败回调前验证 `listening=false`，不是仅观察强制退出。
- 一并修正采集、旧 Socket 和旧配置入口的 `APP_ENV_FILE` 选择；显式文件不存在时在依赖初始化前失败，避免混入默认环境。Socket 的 TS 迁移与业务行为变更仍留待后续阶段。
- 最终检查：`pnpm type-check`、`pnpm build` 通过；guarded `pnpm test:hono` **27/27**；隔离 `pnpm test` **775/775**；`git diff --check` 通过。独立审查的规格和质量结论均通过，无本阶段剩余 Critical/Important 项。修复期间一次类型检查因 `child.stderr` 可为空失败，已修正并重跑通过。验证日志位于 `/tmp/coderx-hono-task2/`（临时文件，耐久结论以本计划为准）。
- 未执行/局限：本机实际为 Node `v26.12.1`，最低 Node 22 运行仍待验；没有确认可丢弃的 PG 测试库，因此未运行 PG 集成。真实 PG/R2/Redis/AI/OAuth/FFmpeg 及线上信号/媒体生命周期未验证，EADDRINUSE 只做注入模拟。当前 Hono 仍是后续路由迁移的基础入口，业务 HTTP、全量 TS/ESM 和发布准备尚未完成，不能作为上线验收。
- 当前分支 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，Task 0–2 全部改动仍在本地未提交。原有 `.gitignore`、`HONO_MIGRATION.md`、`docs/README.md`、Task 0 契约/factory 及 Task 1 锁文件/编译配置与本阶段开始的哈希一致；本计划仅追加状态记录和勾选。没有 push、合并、部署、切流或线上 PM2/Nginx 修改。
- **下一项：Task 3，HTTP 外壳、错误与认证。** 本次完成 Task 2 后停止；发布仍须完成 Task 3–11、Node 版本与隔离集成验收，Task 12 另行授权。

### 2026-11-12 Task 3A 执行记录

- 用户因额度将 Task 3 拆为三个可独立验收的子阶段，并明确开始 **3A：应用工厂与基础 HTTP 行为**。本次完成 3A 后暂停，不实施 3B/3C，不提前勾选 Task 3 整体完成。
- 继续复用当前 `codex/hono-typescript-migration` checkout，HEAD 仍为 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`；未发现适用 AGENTS.md。已复读迁移决定与计划，保留所有本地未提交改动；旧 `.superpowers/sdd/progress.md` 属于无关 Flow 项目，不覆盖。
- 开始前重新运行 `pnpm type-check`、`pnpm build` 与 guarded `pnpm test:hono`：全部通过，Hono **27/27**。本阶段继续强制测试隔离，禁止读取真实 env/密钥或访问外部依赖。
- 首轮实现通过类型/构建与 Hono 33 项测试，但独立审查发现按全局请求路径裁剪尾斜杠会让严格/普通路由相互影响，按 path 存储严格标记也会污染同路径的其他注册。隔离 Koa/Hono 对照确认：严格 GET 数字路由与普通 POST 动态路由重叠时，旧 POST 尾斜杠请求 200，新实现错误返回 404。
- 实现子代理在修复前触及额度限制，主代理继续完成修复：用 Hono TrieRouter 为每条普通注册添加尾斜杠别名，严格注册通过独立 handler 包装标记、不加别名；请求原始路径不改写，Allow 和实际分派使用相同匹配规则。新增真实隔离 Koa 对照测试覆盖注册顺序、跨方法、同方法、复用 handler 和 next 链。6 项回归先失败、修复后全部通过。
- 修复后的 `pnpm type-check`、`pnpm build`、guarded `pnpm test:hono` 通过（**39/39**）；CORS 共用规则提取后原有 `pnpm test` 通过（**775/775**），其后旧入口涉及的 JS 仅补 JSDoc 类型。新增对照测试曾出现 TS7022 类型推断失败，已显式标注 `Response` 并通过重跑。一次替代复审代理请求返回 Bad Request、未产生审查结论；随后由首轮审查代理完成复审，确认全部 Important/Minor 项已解决，无剩余 Critical/Important 项。

### 2026-11-12 Task 3A 完成与交接

- 新增 `src/http/app.ts`、`types.ts`、`dependencies.ts`、`registerRoutes.ts` 和 `compatibility.router.ts`：严格 TS 的纯应用工厂、显式路由装配及注入式 readiness，导入/构建不读取 env/密钥，不初始化真实服务或监听端口。请求用户类型为后续 3C 预留，未提前加入认证逻辑。
- `/health/live` 返回 200 和 status/buildId，不触发依赖探测；`/health/ready` 在注入检查返回 true 时 200，false/异常/超时为 503。候选 bootstrap 已使用新工厂及配置中的 BUILD_ID；尚未装配真实依赖检查，默认 readiness **503**，不将可启动误报为业务就绪。
- CORS 保留旧允许源、未知/缺失 Origin 的回退、credentials、Vary、允许方法/请求头和预检行为。`corsOrigins.js` 仅为新旧入口共享的纯规则提取，使用 JSDoc 明确 string/string[] 类型；它仍是 CommonJS 过渡代码，最终随 constants 在后续阶段完成 TS/ESM 迁移。
- 兼容层保留 plain 404/405、Allow 顺序、普通 OPTIONS、HEAD 空 body、普通字符串路径的可选尾斜杠及注册顺序。严格数字路径通过 `registerStrictRoute` 显式注册，使用 Hono 约束路径语法；严格标记按注册隔离，兼容层复用 Hono TrieRouter，不自写正则解析器。实际业务路由尚未挂载，后续严格路由必须沿用该 helper。
- 验证覆盖纯 factory 导入、健康检查四种结果、CORS 边界、严格/普通路由交叉、资源 404、method/Allow/OPTIONS/HEAD，以及源码/dist 启动后的构建标识、健康状态、配置来源和原有隔离保护。修复的 6 项对照测试先红后绿；最终类型、构建、Hono **39/39**、原有测试 **775/775**、`git diff --check` 均通过。独立规格/质量审查及修复复审通过。
- 分支仍为 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，没有创建提交。原有用户文档/ignore、package/锁文件、Task 0 契约、Task 2 退出流程和测试保护的哈希未变；必要集成仅修改 runtime config、候选 bootstrap、共享 CORS 与启动 smoke，另新增本阶段源码/测试。
- 本阶段未读取真实环境文件、密钥或业务媒体，未连接外部服务，未运行未确认可丢弃的 PG 集成；未 push、合并、部署或修改线上配置。Node 22 运行、真实外部服务集成和发布验收仍待完成，当前结果仅证明本地 3A 范围。
- **下一项：Task 3B，请求解析、错误与日志。** 对照 JSON/form/text 限制及解析行为，补齐 Result/BusinessError/维护错误映射、最终状态日志与脱敏。3C 的 JWT/权限/封禁和 AI 限流仍未开始；本次按约定在 3A 完成后暂停，Task 3 整体不标完成。

### 2026-11-12 Task 3B 执行记录

- 用户明确开始 3B；继续复用 `codex/hono-typescript-migration`，保留全部 Task 0–3A 与用户未提交改动。已复核计划、迁移决定与适用指令（未发现 AGENTS.md），本次不展开 3C。
- 恢复基线 `pnpm type-check`、`pnpm build`、guarded `pnpm test:hono` 通过（39/39）。继续执行测试隔离与临时资源约束，不读取真实 env/密钥，不连接生产或未确认可丢弃的数据库。
- 已核对实际安装的 koa-bodyparser/co-body：旧默认只启用 JSON/form，JSON 1MiB、form 56KiB，text/XML 未启用；畸形 JSON、解析超限等错误经旧全局处理中间件在生产模式下映射为 500/500。将保留这些外部行为，完善最终状态日志及敏感内容隔离，不趁迁移改变错误码。
- 3B 首轮实现通过类型/构建、Hono 48/48 与原有 775/775；范围审查发现 GET/HEAD 请求体丢失、错误字段缺少运行时校验、解析失败后流资源清理不完整。用户因额度要求走小步暂停，先补回归得到 9 pass / 2 fail；随后用户恢复额度并要求继续，暂停要求已撤销。
- 第一轮修复后类型/构建及 Hono 55/55 通过：以 Node adapter 的 incoming 处理 GET/HEAD，清理自有流并保留借用的原始请求，收窄错误状态/业务码并注入开发错误策略。第二轮只读复审补充复现压缩输入中途错误未传播至解压流，可造成 uncaughtException、解析不结束；55/55 不能作为本阶段验收结论，该问题正在补回归和修复。


### 2026-11-12 Task 3B 完成与交接

- 完成请求解析、集中错误处理、维护中间件及最终状态日志。沿用已安装的 `co-body@6.2.0`、`type-is@1.6.18` 并提升为直接依赖，未升级其他依赖；采用严格 TS 的 Node/Web 流适配。解析结果为 `unknown`，后续路由必须从 `c.get('parsedBody')` 读取，不能在已消费的请求上再次调用 `c.req.json()`。
- 保留旧 JSON/form 媒体类型、strict JSON、空对象、重复/嵌套 form、JSON 1MiB 与 form 56KiB 解压后限制；text/XML/multipart 不由此解析器消费。使用真实 Node 请求对照 Koa 的 GET/HEAD 有效、畸形与超限请求体，避免 Fetch 不支持 GET/HEAD body 导致兼容性回退。
- 保留 `BusinessError` 类身份、上传与维护消息及原 `{msg, code}` 响应；显式 `LegacyEmittedError` 区分旧 emit 与普通 throw。旧生产解析错误仍为 HTTP 500 / code 500；无效状态/业务码安全归一化。开发错误策略由入口显式注入，factory 不读取环境。维护开关以函数注入，按修改路由挂载，不全局阻断健康检查。
- 日志在错误规范化后记录最终 method/status/duration，只输出白名单字段，不输出原始 URL/query、JWT、cookie、密码、请求/响应体、AI 上下文或异常消息/堆栈；sink 抛错不会改变响应。候选入口在运行时配置初始化之后延迟装配原 log4js，factory 导入不初始化文件日志。Task 3A 的 CORS、路由与 Task 2 的默认禁用后台任务保持不变。
- 压缩断流修复先以 guarded 定向测试复现失败（0 pass / 1 fail），再通过（1/1）。自有解析流将上游错误传给解压流，保证解析拒绝并执行 finally 清理；取消 Web reader、释放解压资源，借用的原始 Node 请求仅 unpipe/drain，不为清理主动销毁响应 socket。新增真实 Node GET/HEAD 压缩中断测试，验证解析结束且监听器仍能处理后续请求。独立复审重跑原 reproducer 得到规范化 500、进程正常退出，无未捕获异常；最终 spec/quality 均通过，无剩余阻塞项。
- 最终本地验证（Node `v26.12.1` / pnpm `12.11.2`）：`pnpm type-check`、`pnpm build` 退出 0；guarded `pnpm test:hono` **57 pass / 0 fail / 0 skipped**，包含 source/dist 隔离启动与原有 Hono 回归。`pnpm test` 在本阶段首轮实现后 **775 pass / 0 fail / 0 skipped**；随后只修改新增 HTTP 实现/测试，未重复运行该旧套件。`git diff --check` 通过。
- 与 3B 起点快照核对：378 个既有文件中，372 个字节不变；6 个有意修改为本计划、package/lock、Hono bootstrap、app 与 types，另新增本阶段中间件、错误适配与测试。未覆盖其他用户或 Task 0–3A 改动。当前分支 `codex/hono-typescript-migration`，HEAD 仍为 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`；全部改动留在本地工作区，未提交、push、合并或部署。
- **下一项：Task 3C，认证、权限与 AI 限流。** 3B 完成后按子阶段约定暂停，Task 3 整体仍未完成。认证链下游 400/500 不误转 401、临时 RS256 密钥与 HTTP/Socket 一致性、封禁/权限及 AI 代理/IP/限流尚待实现，相关勾选保持未完成。Node 22 实测、已确认可丢弃 PG 库与真实 R2/Redis/AI/OAuth/FFmpeg 集成均未执行；当前无真实业务路由装配，readiness 仍按既定策略返回未就绪，不能发布替代现有服务。完整 TS/ESM 收敛与部署材料属于后续任务，Task 12 仍须另行授权。


### 2026-11-12 Task 3C 执行记录

- 用户在 3B 完成后要求继续，开始 3C：JWT、封禁/资源权限、HTTP/Socket 认证判定及 AI 限流。本次范围到 Task 3 整体验收，不提前迁移 Task 4 业务路由；复用原分支和 checkout，保留所有既有改动，未发现适用 AGENTS.md。
- 延续 executing-plans / subagent-driven-development 的实现与独立复审流程，以及 Hono/TDD/验证技能；为 384 个既有文件保留内容快照。所有测试仍使用 runtime guard 或旧套件 isolated-runtime，测试密钥只在内存/临时资源生成，生产依赖由入口装配。
- 已核对旧 HTTP 支持裸 JWT、只捕获 jwt.verify 错误；封禁为 HTTP 200 / code -1，资源权限失败为 403。AI chat 每 60 秒 12 次、completion 每 60 秒 30 次，按 IP / 登录用户优先分别计数。Socket 的 token 来源/trim 与游客规则单独记录，不把传输层差异误当可随意变更的接口；受信代理需显式核验，不盲信 X-Forwarded-For。
- 进一步核对发现 HTTP 只验证 RS256 签名及 JWT 时间约束，旧接口可接受已签名的字符串或缺 id 对象；Socket 则额外要求 id 非 null 且 name 为真。为遵守有效输入兼容约束，将把原 AuthUser 占位类型改为真实的已验证 payload 联合类型，以 unknown 收窄字段；不凭类型声明新增拒绝规则。HTTP/Socket 一致性验收针对实际签发的用户 token 与共享签名/算法/过期规则，同时测试并记录原有游客、来源、trim 和 identity 差异。登录/OAuth 实际签发仍为 id/name、RS256、7 天过期。
- 已核对安装版本 Koa 的 proxy 默认 false，应用未显式开启；Node adapter 可从 incoming.socket.remoteAddress 取得真实直连地址。新默认继续忽略未受信 X-Forwarded-For；真实部署的代理链配置核验留在部署准备阶段。
- 2026-11-13 完成初版实现与验证，尚待独立复审：定向认证/限流 15/15；type-check/build 通过；Hono 72/72、原有 775/775，全无 fail/skip。认证额外补齐签名 JSON 数组（旧 jsonwebtoken 接受）的 401→200 红绿回归；用户 payload 保持 unknown 字段收窄。测试中本机 127.0.0.2 无法 bind，改用实际可用 127.0.0.1 验证 XFF 伪造，独立 IP 使用显式注入 socket 的单元测试，不修改系统网络配置。Node events 类型导入及路由 param map 的类型错误均已修正。


### 2026-11-13 Task 3C 完成与交接

- 完成 `src/http/middleware/auth.middleware.ts`，通过 `createAuthMiddleware({ publicKey, checkStatus, checkPermission })` 注入临时/运行时公钥和原业务服务结构接口，不导入配置、PG 或日志单例。保持 jsonwebtoken/RS256、裸 JWT 与原 Bearer 替换规则、现有有效期/nbf 判断，认证失败仍为 401 / 原消息。`await next()` 位于验证与权限 catch 之外，业务 400、系统 500 不被误转 401/403，日志记录规范化后的最终状态。
- 将原占位 `AuthUser { id: number }` 改为实际已验证 payload 联合：字符串、数字、布尔值、对象及数组；扩展字段保持 unknown，`authUserId` 安全取值。已签名字符串/缺 id 对象/数组沿用旧 HTTP 接受行为；复审进一步发现带 `typ: JWT` 的数字/布尔 payload 也被旧库接受，补充 7/0/true/false 红灯（401 != 200）后修复并转绿。正常登录/OAuth 的 id/name、7 天签发协议未修改。
- 封禁保持 truthy 状态判断及 HTTP 200 / `{msg:'您已被封禁',code:-1}`；权限按第一项路由参数推导资源表/ID，向注入服务传递真实 token 身份，不采纳 body/query 的伪造 userId。拒绝、undefined 或权限服务异常保持 403；状态服务直接抛出时交集中错误处理。原 authService 自身吞掉数据库错误并可能返回 undefined 的行为未改动；模拟 rejection 测试只证明中间件边界，不能视为真实数据库故障策略验证。
- 将既有 Socket 凭据逻辑提取为纯 `socketAuth.factory.js`，原 `socketAuth.js` 继续装配默认公钥并提供同名 API。验证共享用户 token 的签名、错误公钥/算法、过期与 nbf 判定；保留 Socket 特有的来源优先级、trim、游客与身份字段要求。该小型 CJS 装配边界用于当前旧 Socket 消费方，整体 Socket TS 化仍属 Task 8，不宣称本阶段已完成全部 TS/ESM 迁移。
- 完成 `ai.middleware.ts` 与共享纯 `aiRateLimits.js`：问答每 60 秒 12 次、补全每 60 秒 30 次，独立 bucket；失败请求也计数，到 resetAt 恰好重置。问答按直连 IP、补全优先按 token 的 truthy 用户 ID，否则按 IP；认证在补全限流前执行。每个 factory/进程独立持有内存预算，装配时每个应用创建一次并复用；多进程不会共享额度，不能据此宣称全局限流。沿用旧 Map 的记录保留行为，未引入清理定时任务或 Redis 改造。
- 实际 Node loopback 请求确认 adapter 提供 `incoming.socket.remoteAddress`，并验证伪造 X-Forwarded-For、X-Real-IP、Forwarded 无法绕过预算。独立 socket peer 以注入式单元测试覆盖；当前无受信代理配置，沿用旧 Koa proxy=false 的直连 IP 语义。生产代理链尚未读取/核验，后续部署须明确代理策略；不在此阶段猜测可信地址。
- 最终验证（Node `v26.12.1` / pnpm `12.11.2`）：认证/限流定向 **16/16**；`pnpm type-check`、`pnpm build` 退出 0；guarded `pnpm test:hono` **73 pass / 0 fail / 0 skipped**，涵盖 3A/3B 与 source/dist 隔离启动；`pnpm test` **775 pass / 0 fail / 0 skipped**。旧套件通过后只调整新 HTTP 类型/认证与测试，未重复运行旧套件。`git diff --check` 通过。新增 factory 导入在 guarded 子进程验证无配置/密钥/业务服务/日志副作用。
- 独立审查初次发现数字/布尔 JWT 兼容问题和真实 peer 断言覆盖不足，两项均修复并验证；最终 spec PASS / quality Approved，无剩余阻塞项。相比 3C 起点，384 个既有文件中 380 个字节不变；仅本计划、AI 常量引用、HTTP 类型、旧 Socket 装配有意更新，另新增 6 个本阶段文件。保留全部既有用户及 Task 0–3B 改动；分支仍为 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，全部改动本地未提交。
- **Task 3A–3C 已完成本地范围验收，下一项 Task 4：普通 JSON、上传、AI 流先行验证。** 本次在 Task 3C 收尾，不开始 Task 4。后续实际路由装配必须将原 authService 方法传入，并保持维护/认证/封禁/权限与补全限流的顺序。当前测试使用显式假路由/服务和临时 RSA 密钥，候选尚无完整业务 API，readiness 仍返回未就绪；Node 22、已确认可丢弃 PG、真实 R2/Redis/AI/OAuth/FFmpeg 集成、最终 ESM 收敛与部署材料均待后续执行。未提交、push、合并、部署、切流或访问生产资源；Task 12 仍需另行授权，当前不可替代线上服务。

### 2026-11-13 Task 4A 执行记录

- 已读交接文件、唯一迁移计划、`HONO_MIGRATION.md`，再次检查未发现适用 `AGENTS.md`。复用当前 checkout 与 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`；保留全部用户及 Task 0–3 未提交内容，不覆盖旧 Flow 的 `.superpowers/sdd/progress.md`。
- 已将用户约定的 Task 4A–4E 拆分追加至 Task 4，4A 完成后暂停。开始时对 390 个 tracked/untracked 文件建立临时字节快照，用于阶段差异复审和保留校验。
- 执行顺序：固定标签行为回归 → 类型化业务链路及真实启动装配 → 定向/全量隔离验证 → 独立范围复审 → 更新验收记录。直接 TS 测试和子进程必须预加载 runtime guard；未确认可丢弃的 PG 测试库，不执行真实 PG 集成。
- 已接通真实 `GET/POST /tag`、`GET/PUT /tag/order` router/controller/service/SQL。列表公开，创建与顺序只使用共享 RS256 登录验证，不新增封禁/权限规则；身份来自原 JWT claim，不采纳 body/query 的 userId。沿用 body parser、Result 与集中错误响应；分页保留字符串默认值 `0`/`99`、空字符串及重复键数组，创建不增加输入收紧。
- 标签业务与 SQL 实现位于 `src/service/tag/{tag.service,tag.sql}.ts`，原 JS 路径仅保留短期 CJS 桥，避免 TS/JS 同名输出冲突并让旧 Koa/测试复用同一逻辑。编译配置增加 `rewriteRelativeImportExtensions`，dist 桥引用 `.js`，无回头加载 src。后续旧消费者迁完后移除桥并收敛目录；本阶段不是全量 ESM 收敛。纯 Node v26 执行 source 桥会产生 `MODULE_TYPELESS_PACKAGE_JSON` 警告，未隐藏警告或修改根 package 的模块类型；最低 Node 22 尚未实测。
- 顺序更新保留一个连接、一个事务：校验数组/正安全整数/重复项后获取连接，事务内检查标签是否存在、删旧偏好、非空时插入、读取标准顺序、提交；错误回滚且 finally 释放。保留已保存顺序、未排序 AI 优先、ID 排序 SQL，以及 insertId 等 PG 变更结果字段。验证的是本地调用顺序和响应，不等同真实 PG 原子性验收。
- 为实际候选装配，将旧 PG 实现抽为小型 `pg.factory.js`，共享原配置解析、占位符转换、结果适配、INT8 和凭据日志脱敏行为；未重写数据库层。旧 singleton 与候选复用 factory，候选每次启动拥有独立惰性 pool，生产 logger/keys/DB 由 bootstrap 装配。关闭先排空 HTTP 与任务，再关闭 pool；同步监听异常、异步监听异常、任务启动异常也走清理。默认不加载任务；显式启用旧默认清理任务时记录其共享 pool 并在排空后关闭。readiness 继续 503，不能据此发布替换线上。
- 实际 Koa 对照发现大小写/编码路径差异：`/Tag`、`/TAG/OrDeR/` 原本有效，`/%74ag` 无效。仅为两个标签字面路径加入显式兼容配置，保持原始路径的大小写不敏感匹配及编码拒绝；其他路径不改变。新增真实 loopback Koa 对照覆盖状态、Allow、响应及尾斜杠；并断言既有 health 路径行为不变。
- 红灯与修正：初始标签测试 **0/9**（8 项为 404，1 项缺模块）；启动/关闭测试 **0/5**（未装配路由/未关闭 pool）；类型首轮发现 PG 参数可变性接口不匹配，已按实际 adapter 修正；生命周期夹具首次用了不存在的 mock 调回原函数 API，已修正夹具；路径兼容首次 **24 pass / 1 fail**（混合大小写 404），修正后转绿。失败记录保留在临时报告，未删除旧断言或放松隔离保护。
- 最终全量验证第一轮（Node `v26.12.1` / pnpm `12.11.2`）：`pnpm type-check && pnpm build` 退出 0；`pnpm test:hono` **85 pass / 0 fail / 0 skipped**；`pnpm test` **775 pass / 0 fail / 0 skipped**，两者退出 0。定向 tag/lifecycle/toolchain/routing **31/31**，强化真实 Koa 对照后的 tag **10/10**；旧标签/PG/Koa 定向 **35/35**。旧套件除既有预期错误路径日志外出现上述原生 TS 桥模块类型警告，不称为无警告输出。
- source/dist 真实 Node 候选启动使用显式临时 env/RSA、无效测试 PG URL、127.0.0.1 随机端口，并在 PG Pool query 边界替换结果；覆盖真实 SQL 占位符转换/参数/响应、JWT 身份和未登录拒绝、pool end。guarded 编译 CJS 桥检查通过且无 src 模块加载。所有直接 TS/子进程均预加载 guard，旧模块定向在其后加载 isolated-runtime；未读取真实配置/密钥或连接真实外部服务。计划验收命令示例也已补 guard，避免重用早期不安全命令。
- 首轮独立复审确认业务/事务/装配实现，但通过 guarded Node 原始路径请求复现两项必须修复的 HTTP 差异：`GET /a/../tag` 及 `/a/%2e%2e/tag/order` 被 Node Fetch URL 归一化后命中标签，Koa 应为 404；`PROPFIND` 对已匹配标签路径应为 501 而非 405。已派发范围修复和原始 Node 请求对照回归；首轮 85/85 不能替代这些新增边界验收。原生 TS 桥警告及 Node 22 缺口列为已记录的过渡期限制。
- 首轮复审修复阶段因子代理额度中断；用户明确要求继续 4A 后复核分支、HEAD、源码和报告，保留新增原始请求测试并续做。原始 Node/Koa 对照红灯 **17 pass / 6 fail**（3 个 dot-segment 差异、2 个 PROPFIND 差异及父用例）；修复仅涉及 `app.ts`、`compatibility.router.ts`、`tag.test.ts`。为标签路径读取 `env.incoming.url`，剥离 authority/query 而不重新归一化；已匹配标签的未实现方法返回 501 与原 Allow。保留 Fetch fallback、CORS 和其他路径策略；补充 absolute-form 请求对照。
- 修复后定向 tag/routing/app **34 pass / 0 fail / 0 skipped**。主代理最终执行 `pnpm type-check && pnpm build && pnpm test:hono` 退出 0：**98 pass / 0 fail / 0 skipped**（新增 13 个原始请求差异子用例）；`git diff --check` 通过。旧套件已在业务/数据库/桥最终实现上 **775/775** 通过，后续只改新 Hono 路由匹配和对应测试，未重复旧套件。
- 相比会话起点的 390 个既有文件，379 个字节不变，11 个为有意的本阶段修改，未丢失任何文件；新增 6 个实现/测试文件。原有用户改动、Task 0–3 内容和 Git 历史保留。最终独立复审 **spec PASS / quality Approved**；审查者另以 guarded 原始 Node/Koa 对照 **14/14** 确认两项必须修复的问题均已解决，无剩余阻塞项。
- 未执行条件：真实 PG 集成（未确认可丢弃库）、最低 Node 22、R2/Redis/AI/OAuth/FFmpeg、线上操作；4B–4E、5–12 均未开始。
- **Task 4A 本地范围已完成，按用户约定暂停，不进入 4B。** Task 4 整体仍未完成；下一阶段是 4B 图片上传解析，须待用户继续。分支仍为 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`；全部内容本地未提交，未 push、合并、部署、切流或操作生产资源。
- 本阶段临时证据：`/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task4a-suko0ej0/` 下 `task-4a-report.md`、`task-4a-review.md`（以末尾最终复审为准）、`review.diff`、`final-hono.log`、`full-legacy.log`。临时目录可能被系统清理；本计划与实际源码/测试为长期记录。


### 2026-11-13 Task 4B 执行记录

- 用户在 4A 验收完成后明确开始 4B。重新核对计划、迁移决定、适用指令及 Git 状态，仍未发现 AGENTS.md；分支 `codex/hono-typescript-migration`、HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 未变。保存 396 个既有文件的临时字节快照，保留全部既有改动，原 Flow 账本不动。
- 仅实施 `image` 单文件上传适配层：10MiB、JPEG/PNG/WebP 及解码像素校验、维护→认证→上传顺序和失败清理。当前旧接口使用限额内存文件；4B 不用全请求 formData/arrayBuffer 代替流式 multipart 解析。图片持久化、pending 状态、完整 controller/service 装配留至 4C，批量/视频留至 Task 6。
- 测试仍需 runtime guard 预加载；旧模块另外使用 isolated-runtime，所有媒体仅内存生成或显式临时目录。没有确认可丢弃的 PG 库，不执行真实 PG/R2/Redis/AI 等集成。按行为红灯→最小实现→定向验证→全量隔离检查→独立复审→记录顺序推进，4B 后暂停。
- 边界决定：先复用现有 Multer 2.4 的 Node multipart 实现，通过适配器自有流隔离其监听器，保持恰好 10MiB 可通过、单字段/重复字段/文件名等既有解析行为，不增加依赖。Multer 属于待 Task 9 清除的过渡依赖。图片校验与解析分开，提取共享纯解码逻辑以保留旧服务 userId→缺文件→解码的顺序；不在上传解析层提前改写业务身份校验，也不提前发布未完整装配的图片接口。
- 已实现 `src/http/middleware/mediaImage.middleware.ts`：借用 Node IncomingMessage 或桥接 Fetch Request body，交给自有 PassThrough/Multer parser；不整体读取 multipart。保留 `image`、10MiB（含等号）、MIME、文件元数据、重复/嵌套文本字段和文件名语义。文件与 multipart fields 仅在下游处理期间存在，finally 恢复上下文并释放流/监听器/缓冲引用；不新增磁盘暂存。非 multipart 沿用旧跳过解析行为。Multer 的 streamHandler 是当前已安装版本接口，最终依赖清理时需要替换。
- 新增严格 TS `mediaImageInput.service.ts`，将类型、大小、Sharp 元数据/像素检查及原图 rotate/resize/WebP 解码从旧 service 提取共享。仅 metadata 不能识别部分像素截断，因此保留真实解码；旧 service 仍负责缩略图、UUID、业务身份校验和持久化。source CJS 直接引用 TS，dist 通过既有 rewriteRelativeImportExtensions 引用 JS。保留 normalizeImage 的格式错误与 createPendingImage 的缺文件错误区别，没有提前迁移 pending/数据库链路。
- Hono 会在 await next 返回前集中处理下游错误，因此加入仅上传处理期间有效的上下文标记，将下游 LIMIT_FILE_SIZE 映射为原 400/400 和“图片大小不能超过 10MB”；解析自身的同类错误由适配器转换。标记在 finally 清除，同一异常在上传链之外仍沿用原错误策略。大小及格式消息提取为共享常量，旧 Koa 中间件同步引用。
- 红灯证据：缺少解析/解码实现时，真实 Node 图片上传用例返回 500 而非预期 200；新增畸形 multipart header 的 Web body 取消测试发现未取消（false），补充取消未锁定 body 后转绿。首轮类型检查指出 Fetch Buffer/duplex 和元数据字面类型的测试类型问题，均已修正；最终测试采用静态类型导入，无缺实现 fallback。
- 已完成定向验证：guarded `test/http/mediaImage.test.ts` **12 pass / 0 fail / 0 skipped**；guard + isolated-runtime 的旧 media controller/service **26/26**，包含维护中间件的定向 **29/29**。覆盖真实 JPEG/PNG/WebP、恰好 10MiB 与多 1 byte、真实 40,000,000/40,005,000 像素 PNG、注入式多 1 pixel、声明/解码 MIME 不符、像素截断但 metadata 可读、缺/重/错字段、畸形/截断 multipart、维护/认证之前不读 body、下游失败和上传中断后的监听器清理及后续请求可用。图像均内存生成。
- 2026-11-14 主代理完整验证（Node v26.12.1 / pnpm 12.11.2）：`pnpm type-check && pnpm build` 退出 0；guarded `pnpm test:hono` **110 pass / 0 fail / 0 skipped**；isolated `pnpm test` **775 pass / 0 fail / 0 skipped**，两套测试进程均退出 0。`git diff --check` 通过。旧套件仍有已记录的 tag 原生 TS 模块类型警告与预期错误路径日志，不宣称无警告输出。
- 保留校验：396 个既有文件中 390 个字节不变，6 个为本阶段有意修改（含计划），没有文件丢失；新增 3 个文件。不改 package/lock、不启动生产入口、不连接真实 PG/R2/Redis/AI、不读取真实 env/密钥或用户媒体。4C 业务装配、Node 22 实测、外部隔离集成及部署仍未执行。
- 2026-11-14 首个独立复审子代理因额度限制中断，没有生成复审报告；已由另一独立复审完成，最终 **spec PASS / quality APPROVED**，无需要修复的问题。复审另外以 guard 执行 Fetch 请求预先取消、上传中取消、reader error、截断 body 四项探针，均正常结束，无未处理异常；未重复全量套件。临时证据位于 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task4b-4bp7ofcx/`：`task-4b-brief.md`、`task-4b-report.md`、`task-4b-review.md`、`review.diff`、`full-hono.log`、`full-legacy.log`；临时目录可能被系统清理，本计划与源码/测试为长期记录。
- 另完成 guarded 纯 Node 编译产物 smoke：实际加载 dist 的 app/upload middleware/decoder，以内存 PNG、FormData 调用 parser→decoder，验证输出尺寸/WebP 格式并断言没有加载 src 模块，退出 0。最终计划记录与 diff 检查通过。
- **2026-11-14 Task 4B 本地范围验收完成，按约定暂停，不进入 4C。** 完整图片接口、pending 状态与实际 controller/service 装配仍未完成，原 Task 4 媒体验收项继续保持未勾选。分支 `codex/hono-typescript-migration`、HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 不变，全部改动本地未提交；未 push、合并、部署、切流或操作生产资源。


### 2026-11-14 下一会话交接

- 用户要求在开始 4C 前更新原有 handoff，并在下一会话继续；本次仅更新交接材料，不实施 4C。
- 已更新原路径 `/tmp/coderx-hono-task4a-handoff-cxicb18y.md`，保留历史文件名但将下一阶段改为 4C，写明 4A/4B 完成结果、现有接口、实际 Git 状态、本地/测试隔离边界、待验条件及完成 4C 后暂停、不进入 4D 的范围。临时文件缺失时以本计划和源码/测试为准。

### 2026-11-14 Task 4C 执行记录

- 用户明确要求阅读 handoff 后继续 4C，完成实现、验证、复审和计划记录后暂停，不进入 4D。已核对唯一计划、迁移决定、隔离保护和实际 Git 状态；未发现适用 AGENTS.md。
- 复用 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`；建立会话开始时的文件快照，保留全部未提交内容，不改旧 Flow 账本。
- 本阶段执行顺序：先固定图片业务行为红灯 → 严格 TS service/controller/router 与候选装配 → 定向及全量隔离验证 → 独立复审 → 更新验收记录。仅先行图片业务；AI、批量图片和视频保持后续任务范围。
- 测试先加载 runtime guard，旧模块另加载 isolated-runtime；使用临时 env/RSA/媒体、127.0.0.1 随机端口及 DB/存储替身，不连接未确认可丢弃的数据库或真实外部服务。临时证据目录：`/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task4c-0xe9b5f7/`。

- 已接通真实候选的 `POST /media/images`：注入式 router/controller → 共享严格 TS 上传业务；保留维护→JWT→流式上传→业务次序、JWT 身份优先于缺文件/解码校验、原 Result 与 HTTP 错误。大小写/尾斜杠/原始编码及 dot-segment/方法通过 Koa 对照；Hono 的 DELETE 和媒体读取/批量/视频仍属后续阶段，旧 pending 删除业务保持。
- 业务实现位于 `src/service/mediaImage/mediaImage.service.ts`，旧 `mediaImage.service.js` 的上传与 normalizeImage 委托到同一核心，删除逻辑不复制。复用 4B 解码，保持原图最大 2560、缩略图 640、WebP 质量 82/76、UUID 命名及元数据。pending 保留原 file/image_meta 插入及未关联语义，不新增状态字段或迁移 SQL。
- 保留独占 `wx` 创建、仅记录本请求拥有的路径、部分写入/重复文件/数据库失败补偿及 rollback/release。发现并修复旧 URL resolver 抛出 null 时的处理缺口；响应 URL 查询移至提交并释放连接之后，提交后不再进入文件补偿，避免误删已提交文件及持有连接再请求同一连接池。
- `mediaImageUrl.service.ts` 以候选独立 pool 装配现有 URL/object/local/public-R2 factories，惰性初始化，保留 local/r2_preferred、缩略图回退及 URL 编码。仅改相关旧 factory 的 alias 引用为相对路径以保证无旧默认配置/pool 的直接 bootstrap 导入；不重写整套存储，不创建可调用真实 S3 的 client。运行时配置沿用已有媒体默认值。
- 实现代理报告的红灯：source/dist 候选 smoke **1 pass / 2 fail**（上传入口未挂载，404 而非缺文件 400）；新增 postcommit 回归 **0 pass / 1 fail**（null 导致旧 error.message 访问抛 TypeError）。原始红灯日志未另行保存，以上为代理消息记录；后续绿灯由主代理完整复验。实现中发现 URL factory 的 JS 推导 any 会吞掉交叉类型，已改为显式数据库接口再做类型检查。
- 实现代理在源码和测试冻结、定向测试完成后撰写报告时因额度中断，未产生最终自审报告；主代理依据实际 diff、消息和亲自运行的完整测试补齐 `task-4c-report.md`，并发起独立复审，不把中断当成完成结论。
- 2026-11-14 主代理验证（Node `v26.12.1` / pnpm `12.11.2`）：`pnpm type-check && pnpm build` 退出 0；`pnpm test:hono` **111 pass / 0 fail / 0 skipped**；`pnpm test` **776 pass / 0 fail / 0 skipped**，两套进程正常退出；`git diff --check` 通过。定向 guarded toolchain/mediaImage/lifecycle 为 **28/28**，guard + isolated 旧媒体 controller/service/maintenance 为 **30/30**。旧套件仍有已知原生 TS 模块类型警告和预期错误日志，不称为无警告输出。
- source/dist smoke 通过实际 Node multipart、Sharp 和临时媒体目录，PG 在驱动边界使用替身：验证真实占位符转换、file/image_meta 顺序和元数据、commit/release、第二次上传失败的 rollback 和新文件补偿，以及此前成功媒体保留。源码验证 local URL；纯 Node dist 验证 R2-preferred URL 与缩略图回退，断言不加载 src。guard 禁止真实 env/密钥和外部连接；这些不等同真实 PG/R2 集成。
- 保留校验：起点 399 个既有文件，388 个字节不变，11 个为有意修改（含本计划），未丢失文件；新增 4 个实现文件。package/lock 未改，全部改动本地未提交。最低 Node 22、真实 PG/R2/Redis/AI/OAuth/FFmpeg 和线上操作仍未验证，readiness 保持 503。
- 独立复审最终 **spec PASS / quality Approved**，无 Critical/Important 问题。复审核对共享严格 TS 实现、文件所有权、提交后补偿边界、URL defaults、原始路由/身份契约和 source/dist 装配；读取已有完整验证日志，未重复套件或访问外部资源。轻微事项：新增 fallback 回归会输出两条预期 console.error，后续可在测试中捕获并断言；既有 MODULE_TYPELESS_PACKAGE_JSON 警告留至模块格式收敛阶段，不改生产错误日志或隐藏警告。
- 最终范围保留校验和 `git diff --check` 通过。复审报告、主代理补齐的实现报告及验证日志见上述临时目录的 `task-4c-review.md`、`task-4c-report.md`、`review.diff`、`full-hono.log`、`full-legacy.log`；临时文件可能被系统清理，本计划与源码/测试为持久记录。
- **Task 4C 本地范围验收完成，按用户要求暂停，不进入 4D。** Task 4 整体尚未完成，4D AI UIMessage 流和 4E 取消/背压/联合验收均未实施；下一次继续从 4D 开始。当前分支 `codex/hono-typescript-migration`、HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 不变，全部内容本地未提交，未 push/合并/部署/切流或操作生产资源。

### 2026-11-14 Task 4D 执行记录

- 用户确认 4C 完成后要求“继续”，本阶段执行 4D AI 流输出，完成实现、验证、复审及记录后暂停，4E 取消/背压/资源关闭专项与后续阶段不在本轮范围。
- 再次核对 Git/计划/隔离保护，未发现适用 AGENTS.md。继续复用 `codex/hono-typescript-migration`，保留 0–4C 及所有用户未提交改动；起点快照及本阶段证据目录：`/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task4d-qi5mk427/`。
- 保持旧 `/ai/chat` 游客访问、chat limiter、输入校验、模型白名单/目录缓存、上下文处理及 SDK UIMessage 协议。SDK 官方参考：[streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)、[错误处理](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)、[UIMessage 协议](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)，实现仍以本地锁定版本 API/源码为准。
- 本轮仍仅本地：所有直接 TS 测试及子进程预加载 guard，旧模块额外 isolated-runtime；临时配置/密钥与 127.0.0.1:0 测试服务，不连接真实 AI/PG/R2/Redis，不读取实际 env/密钥。health/completion 完整路由迁移留后续。

- 已新增 `src/http/router/ai.router.ts`、薄 controller 及 `src/service/ai/{ai.service,aiConstraints.service}.ts`；候选真实装配 `POST /ai/chat`，保留游客访问、12 次/IP/分钟、先限流再校验、原始路径兼容与原 JSON 错误 envelope。原 Koa 的聊天/模型目录/模型解析委托共享严格 TS 核心，health/completion 路由未迁移；旧 Utils/AI constraints 通过过渡桥共用清洗、提示词、工具、缓存和错误映射。
- 旧 validator 允许的 content-only、system/tool 等宽输入仍由 SDK 转换处理，下游失败维持 503，而非新增输入收紧；服务内 UIMessage 断言仅用于保留该已知兼容边界，未以 any 包装旧业务。模型 allowlist、缓存 TTL、undefined 默认模型与 null 回退、最近 20 条历史、文章/选择上下文清洗、工具开关/步数保持。
- 返回 SDK `toUIMessageStreamResponse()` 的未缓冲 body 与 headers。测试发现直接返回 Response 会丢失 Hono 已准备的 CORS，因此用 `c.newResponse(response.body, response)` 保留同一流并合并响应头。真实 SDK 模型替身及实际 Node 本地 provider 都以门控证明首段文字在生成结束之前到达，协议、error chunk、`[DONE]` 与 CORS 保留。
- 错误语义：发现/选模型/消息转换等在响应建立前失败时返回原 503 JSON；SDK 异步 provider 失败（包括尚未产生文字）保持 HTTP 200 与 SDK 遮蔽的流内 error，不预读整流强行改成 503。生产日志仅输出固定 setup-error/stream-error 事件；旧 controller 不再打印流字节和原始错误内容。
- SDK 兼容决定：本地 AI SDK 7 忽略旧 `maxTokens: 4096`，新严格 TS 实现移除该无效选项，未添加新的有效 `maxOutputTokens` 上限；测试核对 provider 选项仍为 undefined。此处保留实际行为，不能宣称原代码已有效限制 4096 tokens。
- 第一实现代理只留下真实候选 404→预期 400 的红灯与调查记录，未修改生产代码；随后由新实现代理完成共享核心、测试和装配。原始及复核红灯日志为 `red.log` / `red-reconfirmed.log`。独立复审首个代理因模型额度中断，未给出结论，已派替代复审，不将中断视为验收。
- 首轮主代理 `pnpm type-check && pnpm build` 通过，`pnpm test` **776 pass / 0 fail / 0 skipped**；`pnpm test:hono` **117 pass / 3 fail**。失败均为纯 Node 直接导入 dist bootstrap 时，AiValidUtils 的 `@/constants/ai` 仍依赖未注册别名。已通过 guarded lifecycle 复现 **9/12**，仅将该引用改为相对路径；未修改测试或放宽保护。
- 修复后主代理再次执行 `pnpm type-check && pnpm build && pnpm test:hono`，全部退出 0，Hono **120 pass / 0 fail / 0 skipped**。修复定向 lifecycle **12/12**、Task 4D **9/9**、guard + isolated 的 AI helpers **6/6** 均通过。别名修复仅改导入路径，其后未重复整套旧测试；相关旧工具已定向复验。旧套件仍有原生 TS 模块类型警告及既有预期错误路径日志，不称为无警告输出。
- 本地 provider 仅监听 127.0.0.1 随机端口；源码与 dist bootstrap 均运行真实 SDK HTTP 流。既有纯 Node toolchain/lifecycle 验证 dist 导入路径、无 src 回退、启动与退出；测试未访问真实 AI/PG/R2/Redis 或真实 env/密钥。真实 AI 服务与最低 Node 22 仍未验证；4E 客户端断开、停止下游、背压/资源关闭专项不在本轮验收。
- 快照保留校验：起点 403 个既有文件，396 个字节不变，7 个有意修改（含本计划），无文件丢失；新增 6 个实现/测试文件。package/lock 未变，全部内容本地未提交。
- 独立替代复审最终 **spec PASS / quality Approved**，无 Critical/Important/Minor 待修复项。确认实际候选/旧消费者共享、宽输入兼容、SDK 未缓冲响应、CORS、模型/上下文/工具/限流、固定安全日志及别名修复；4E 和真实服务条件明确排除在 4D 结论之外。完整报告见 `task-4d-review.md`，实现/修复证据在 `task-4d-report.md` 与同目录 `red*.log`、`green.log`、`fix-*.log`、`final-hono.log`、`full-legacy.log`；临时文件可能被系统清理，本计划及源码/测试为持久记录。
- 最终 `git diff --check` 与文件保留检查通过。**Task 4D 本地范围验收完成，暂停，不进入 4E。** Task 4 整体仍未完成，下一项为 4E 客户端断开、停止下游生成、背压/资源关闭及三链路联合验收；本轮未实现这些专项。分支 `codex/hono-typescript-migration`、HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 未变，没有提交/push/合并/部署/切流或生产资源操作。

### 2026-11-14 Task 4E 执行记录

- 用户在 4D 完成后提供 Win 本 `100.119.144.76` 的 ping 结果并要求继续；本轮继续 4E 取消、停止下游、背压与关闭、三链路联合验收，完成后暂停，不进入 Task 5。
- 主代理只读检查 `http://100.119.144.76:11434/api/tags`，HTTP **200**，模型目录包含 `qwen3.5:2b`、`deepseek-r1:7b`、`qwen2.5:7b`。这证明 Ollama 模型接口可响应，不等同真实生成、取消或完整生产链路通过。未读取实际 env/密钥，未执行远程生成或修改服务。
- 复用 `codex/hono-typescript-migration`，保留 0–4D 及用户全部未提交改动。起点快照和本阶段证据：`/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task4e-_p45ufbm/`；所有自动测试继续预加载 guard，旧模块另加 isolated-runtime，使用临时资源和本地 provider，不因上述只读检查放宽测试网络保护。
- 先固定断开/取消行为红灯，再接通请求生命周期信号，检查 SDK 内部流/背压与监听器关闭，并执行 tag/image/AI 联合回归。已有 4D 正常流、错误、CORS、访客/限流和业务契约必须保留。

- 实施前核对已安装 Node adapter 的 drain/request abort 行为及 SDK 内部 tee/取消路径。参考 [SDK 停止流](https://ai-sdk.dev/docs/advanced/stopping-streams)、[背压](https://ai-sdk.dev/docs/advanced/backpressure) 与 [后台消费说明](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)；不能为触发完成回调而普遍开启后台消费，否则会破坏背压。实际保证以锁定版本源码及受控测试为准，不宣称 SDK 内部存储为全局常量内存。

#### 2026-11-15 恢复与验证

- 用户要求简述进度健康情况后继续。实现代理此前因模型额度中断，已保留 controller/service 的取消实现、新测试和红绿灯日志，但未完成最终报告/自审。主代理重新核对分支/HEAD/源码和证据，补齐实现清单并执行新一轮完整验证，独立复审尚在进行；不因中断或测试绿灯提前勾选 4E。
- 实现将可选 AbortSignal 从 controller 传入目录查询、模型选择、SDK 生成及附件下载；取消后的目录响应不得污染并行请求的缓存。controller 用请求专属 AbortController 和单 reader、highWaterMark 0 的 body 包装保留原 SDK 字节流/CORS；不新增后台 drain/tee/消费，取消时独立中止 provider，释放自有 reader/监听器，不等待 SDK 保留分支的取消 Promise。
- 已有红灯日志：`red.log` **1 pass / 4 fail**（背压原本通过，取消与信号缺失；Node 首次为客户端 ECONNRESET 夹具问题），修正夹具后的 `red-node.log` **0/1** 明确等待不到下游 socket 关闭；`red-extra.log` **0/2** 发现编码异常未停止模型、附件下载未取消；`red-sanitization.log` **0/1** 发现原始编码错误可能把 provider 内容传给 Node adapter 日志。当前实现对 fatal body error 停止 provider 并返回固定传输错误。
- 恢复后主代理执行（Node `v26.12.1` / pnpm `12.11.2`）：`pnpm type-check && pnpm build && pnpm test:hono` 退出 0，Hono **127 pass / 0 fail / 0 skipped**；`pnpm test` 退出 0，旧套件 **776 pass / 0 fail / 0 skipped**；`git diff --check` 通过。新 4E **7/7** 纳入完整 Hono 套件，包含目录/Fetch body/实际 Node 断开、SDK 编码错误、附件下载、监听器释放与慢客户端背压。旧套件仍有已知模块类型警告和预期错误日志。
- 联合验证包含既有 tag/image/AI 契约、真实 Node multipart、source/dist 候选装配及生命周期；DB 使用替身、AI 使用 SDK mock 或本地可控 provider。此前 Win 本仅验证模型接口 HTTP 200，不将其记为真实生成/取消通过；Node 22、真实 PG/R2/Redis/AI 生成/OAuth/FFmpeg 和生产仍未验证。
- 起点 409 个文件，406 个字节不变、3 个有意修改（含计划），新增 1 个测试文件，无文件丢失；package/lock 不变。最终独立复审和 4E/Task 4 完成勾选待结论。
- 首轮独立复审为 **spec FAIL / quality Needs fixes**：附件下载使用 `Promise.all`，某个下载失败后，同组其他下载仍可能继续；SDK 将失败转换为 error chunk/EOF 时，正常响应收尾不会取消它们。已核对源码确认此资源清理缺口，派发下载组专属取消修复与双附件回归；完成修复、覆盖验证及复审前，4E 保持未完成。
- 修复增加下载组专属 AbortController，与请求信号组合；任一下载失败时取消剩余下载并重抛原错误，正常结束不取消请求。新增双附件回归使用真实本地 HTTP 服务和实际 SDK downloader，通过测试内 fetch 映射满足 SDK URL 校验且禁止外网；一个附件返回 500，另一个保持连接，验证响应 error/[DONE] 后后者关闭、请求未取消、模型未启动及错误内容脱敏。红灯 **0/1**（等待 sibling socket 关闭超时），绿灯 **1/1**，覆盖 4D/4E **17/17**；类型检查与构建退出 0，证据见 `task-4e-download-*.log`。
- 修复后主代理运行最终全量验证：`pnpm test:hono` **128 pass / 0 fail / 0 skipped**，`pnpm test` **776 pass / 0 fail / 0 skipped**，均退出 0；`git diff --check` 与文件保留检查通过。4E 现有 **8** 项回归纳入完整 Hono 套件；证据见 `final-hono.log`、`final-legacy.log`。代码已冻结，独立复审进行中。
- 最终独立复审 **spec PASS / quality Approved**，确认下载组失败清理缺口已修复，无 Critical/Important/Minor 待修复项；初次反馈与最终结论均保留在 `task-4e-review.md`，完整实现/修复和命令记录在 `task-4e-report.md`。临时证据可能被系统清理，本计划及源码/测试保留持久结论。
- **Task 4E 与 Task 4 三链路本地验收已完成，按约定暂停，不进入 Task 5。** headers 前后错误、取消传递、实际 Node 断开/背压/关闭及标签/图片/AI 联合回归均在本地范围通过；真实集成、最低 Node 22 和生产条件仍按上述记录待验。最终保留检查：409 个起点文件中 406 个字节不变，3 个有意修改（计划及 AI controller/service），新增 1 个测试文件，无文件丢失，package/lock 不变。分支 `codex/hono-typescript-migration`、HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 未变，全部改动本地未提交，未 push、合并、部署、切流或操作生产资源。

### 2026-11-15 Task 5A 执行记录

- 用户明确授权从 5A（user、oauth）继续，完成实现、隔离验证、独立复审和计划记录后暂停；不进入 5B，不进行部署或生产操作。复用当前 `codex/hono-typescript-migration` checkout，HEAD 为 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，未发现适用 AGENTS.md。
- 已复读交接、迁移决定、Global Constraints、Task 2 隔离事故、Task 4E 完成记录和 Task 5 分组。开始前为 410 个既有文件保存内容与 SHA-256 快照，证据目录 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task5a-lkj8mxt0/`。本计划是唯一账本，未改动旧 Flow 账本。
- 实际范围为 13 条 user 路由和 6 条 OAuth 路由；注释中的 feedback/article 路由不新增。沿用纯 factory、`parsedBody`、认证和路径兼容层，保留有效输入、重复 query、序列化、JWT 与回跳协议。验证仅允许显式替身和临时资源，直接测试及子进程预加载 guard；不访问真实 OAuth/PG/Redis、env、密钥或媒体。
- 本阶段进行中，最终命令、失败修复、独立复审及保留性核对将在完成后记录；不能据既有 Task 4E 通过记录提前判定 5A 完成。
- 隔离基线：主代理运行 user 凭据日志、user service/middleware/SQL、OAuth service/SQL、avatar service 和 notificationEventBus 八个旧测试文件（`node --require ./test/support/runtime-guard.js --require ./test/support/isolated-runtime.js --test --test-concurrency=1 ...`），**42/42**，日志 `legacy-targeted-baseline.log`。旧 Koa 的临时探针确认动态路径大小写/一次解码、重复 query、头像缺记录 404、HEAD 无正文、Range 返回完整头像，以及数字 ID 自关注的既有 500；缺磁盘文件的 GET 会断开 socket，探针捕获此错误后退出 1，已在 finally 关闭监听和删除临时资源，后续正常读取探针退出 0。
- 红灯与中途失败保留：OAuth 新端点首次 0/5；补 HEAD 长度断言后 3 pass / 2 fail，修复后 5/5。旧 OAuth 测试对旧实例 `client` 字段赋值未能替换新闭包客户端，guard 拦截了一次 Google 证书连接尝试，未建立外部连接；改用显式 provider 注入后旧 OAuth/SQL/契约 20/20。其他中途失败含夹具语法、原生 TS signer 兼容、Hono 动态参数可空和 fixture 类型收窄，最终整体检查尚待完成。
- user 源码/dist 装配红灯为登录路径 404（2 fail / 1 pass），首次实现后 3/3。user 首轮 6/7 中的 form 夹具缺少线上请求具有的 Content-Length，已定位为测试夹具差异；新通知 publisher 生命周期断言又捕获关闭期间连接随后成功仍遗留客户端的问题（1 pass / 1 fail），修复与最终复验进行中。

### 2026-11-16 Task 5A 复审与继续记录

- 用户明确要求继续，仍只完成 5A 后暂停。已核对实现代理报告和源码；实现代理随后额度中断，不视为工作丢失或自动通过，主代理继续验证和组织修复。
- 首轮整体检查：主代理 `pnpm type-check`、`pnpm build` 退出 0，guarded `pnpm test:hono` 完整日志 **143/143**，恢复后旧 PTY 会话 ID 已过期，不能再回收进程退出状态；定向实现报告中 18/18 的命令退出 0。`pnpm test` 于继续后执行，退出 0，**776 pass / 0 fail / 0 cancelled / 0 skipped**，`git diff --check` 通过。
- 主代理额外尝试 `NODE_OPTIONS='--require=./test/support/runtime-guard.js' pnpm test` 得到 **774 pass / 2 fail**；失败分别是 `test/service/mediaStorage.config.test.js:53`、`test/tasks/contentIngest.worker.test.js:118` 读取仓库中受版本控制的 `.env.example` 模板，被 guard 的 env 文件名规则拦截。未改保护逻辑或测试来放宽权限；随后按既有 `isolated-runtime` 默认脚本复验得到上述 776/776。额外 guard 的失败记录保留，不能称该命令通过。
- 独立复审首轮 **Spec PASS / Quality Needs fixes**，未发现新增 HTTP 契约回归。Important 项是抽取后仍隐式丢弃五个 user 查询异常，属于旧行为而非新回归；按既定兼容要求保留 HTTP 200 / `{code:0}` 和省略 data，将以明确的内部失败结果/兼容适配与失败断言修正质量边界。另记录 JWT 局部全局声明、头像 Web 流双重断言、测试预期诊断未捕获三个类型/测试质量问题，已交由新修复代理统一处理，不扩大到 5B。
- 复审额外用已安装 Redis 客户端连接测试进程的静默 `127.0.0.1:0` TCP fixture，验证握手期间关闭会拒绝待发布请求并关闭 peer，退出 0；这只验证本地客户端生命周期，未连接真实 Redis 服务。完整首轮复审见临时证据目录 `task-5a-review.md`。最终通过结论仍待修复后的覆盖验证和复审。
- 复审修复已保留在源码：五个 user 查询方法抛出原始异常，由共享、具有泛型返回类型的 `legacyUserQueryResult` 在旧 service 入口与新 HTTP 边界显式记录一次诊断并映射为原有 undefined；新断言覆盖内部拒绝、正常无记录与失败的区别、旧 service 调用和 HTTP 200 / code 0 / data 省略。新增头像真实文件断言验证读取有界和取消后关闭，响应适配使用 `unknown` reader、字节校验和按需拉取，移除双重断言；移除局部全局 JWT 声明，精确新增 devDependency `@types/jsonwebtoken@9.0.10` 及其类型依赖 `@types/ms@2.1.0`，没有运行时依赖升级。修改过的 user 测试捕获并断言预期诊断；原生 TS 模块警告和无关旧测试日志仍如实保留。
- 修复代理报告 guarded 定向 Hono **21/21**、受影响旧套件 **87/87**、类型/构建/diff 检查退出 0。后续用户再次要求继续时，原临时证据目录和旧 handoff 已被清理，源码仍在；不重做已完成实现。主代理新建 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task5a-final-yifii9p3/`，保存恢复时 425 文件哈希及当前审查包，重新执行最终检查，每项同时记录日志和 JSON 退出码。
- **当前修复版的主代理新验证：** `pnpm type-check`、`pnpm build`、`pnpm test:hono`、`pnpm test`、`git diff --check` 全部退出 0；Hono **146 pass / 0 fail / 0 cancelled / 0 skipped**，原有套件 **777 pass / 0 fail / 0 cancelled / 0 skipped**。新目录中的 `final-*.log` / `final-*.json` 为该次证据。最终独立复审进行中，尚未勾选完成。

### 2026-11-16 Task 5A 完成与暂停

- **最终独立复审 Spec PASS / Quality Approved，无剩余 Critical/Important/Minor 可执行项。** 新审查者检查当前源码、修复后的类型/失败边界、路由清单、OAuth、流与资源生命周期，并读取本轮最终检查的日志和退出码。完整结论见新临时证据目录 `task-5a-final-review.md`；临时文件可能被清理，耐久结论以本计划与源码/测试为准。
- user 的 13 条路由全部映射至 `src/http/router/user.router.ts` / `src/http/controller/user.controller.ts`：GET `/user/checkAuth`；POST `/user/{register,login}`；GET `/user/:userId/{collect,comment,profile,like,avatar,follow}`；PUT `/user/profile`；GET `/user/hot`；POST `/user/:userId/{follow,report}`。OAuth 的 6 条路由映射至对应 oauth router/controller：GET `/oauth/{status,google,google/callback,github,github/callback}`，POST `/oauth/google/idtoken`。`test/http/task5a-user.test.ts` 对照原 85 路由基线核对这 19 条注册，未新增注释路由，未进入 5B。
- 候选 source/dist 均接通真实注册/登录处理、共用 RS256 七天 JWT、认证、资料/查询/关注/举报、头像读取及 OAuth 服务。数据库和 OAuth provider 在测试中显式替换，临时 RSA/媒体和真实 loopback Node 监听验证装配；关注通知复用原事务和事件协议，候选持有独立惰性 PG pool 与可关闭 Redis publisher。user/notification 的共享 JS factory 是过渡，不声称 Task 7 全面类型化完成。
- 保留实际契约：静态路径大小写不敏感、参数大小写/一次解码、重复 query、null/undefined/日期/数字序列化；头像缺记录 404、HEAD 空正文、Range 返回完整内容、HTTP/1 缺文件断连；自关注原有 500；五个旧查询失败的 HTTP 200 / code 0 / data 省略。后两项为明确兼容行为，内部失败现在可由核心调用方捕获，并有独立断言保护。
- **最终验证环境 Node `v26.12.1` / pnpm `12.11.2`：** 类型检查、构建、Hono **146/146**、旧套件 **777/777**、`git diff --check` 全部退出 0，没有失败/取消/跳过；预期旧诊断和原生 TS 模块警告仍存在，不称无警告输出。覆盖验证包含新用户失败边界与头像取消断言，不仅是路由注册检查。
- 保留性证据：旧临时快照清理前最后一次核对，起点 410 文件中 **392 个字节不变、18 个有意修改、新增 15 个、无删除**；有意修改含计划、必要源码/旧桥接/测试和新增类型依赖的 package/lock。原快照现已不可重读，不能声称重新验证了它。恢复后重新保存的 425 文件快照最终核对为 **424 个字节不变、仅本计划更新，无新增或丢失**，确认最终复审期间源码/测试未变（`final-preservation.json`）。当前分支仍为 `codex/hono-typescript-migration`，HEAD 仍为 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，未创建提交。
- **本轮在 5A 完成后暂停，不进入 5B。** Task 5 整体仍未完成，下一执行单元是 5B（tag/history/collect/notification）。没有 push、合并、部署、修改线上配置或操作生产数据库/媒体/密钥。最低 Node `22.22.2`、真实 PG/OAuth/Redis/R2/AI/FFmpeg 集成仍未验证，候选 readiness 仍为 503，不能作为全量 API 上线；Task 12 仍须另行授权。

### 2026-11-17 Task 5B 执行记录

- 用户明确授权继续 5B（tag/history/collect/notification），本轮按此前分组方式完成实现、隔离验证、独立复审和记录后暂停，不进入 5C。仍在 `codex/hono-typescript-migration`，HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，未发现适用 AGENTS.md。
- 已重读计划、5A 完成记录、交接文件和测试保护，起点 425 个文件的内容及 SHA-256 保存于 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task5b-lw7u1l8o/`。保留全部未提交改动，继续使用本计划作唯一账本。
- 实际范围共 19 条路由：tag 4 条复用既有实现，history 5 条、collect 6 条、notification 4 条补齐候选。重点核对分页强制转换/默认值、收藏认证及所有权顺序、通知接收者隔离与已读状态、标签顺序事务。复用 5A 的 notification factory 和候选自有 PG，不引入旧配置/数据库单例。
- 阶段初期不据既有 5A 结果宣称本阶段通过，以下分别记录红灯、修复、最终命令、独立复审与保留性结果。只用显式替身和临时资源，无真实外部集成或生产操作。
- 主代理 guarded 旧 controller/service/SQL 定向基线 **72/72**，退出 0（`baseline-legacy-targeted.log/json`）；独立旧 Koa loopback 探针退出 0（`legacy-probe.cjs/log/json`），确认历史缺分页参数会输出 null、重复 query 保留数组、通知 HTTP 默认 offset `"0"` / limit `"10"`、收藏先鉴权/权限再校验且部分操作保留后置数字转换。探针全部使用显式服务替身、内存 RSA，监听在 finally 关闭。
- 实现红灯已记录（`task5b-red.log/json`）：当时候选尚未装配 15 条新增路由，相关成功/错误断言返回 404；同时捕获既有 tag HEAD 与 JWT 错误 JSON charset/Content-Length 的 Koa 差异，共 27 项失败。随后按同一组断言实现与修复，不把红灯当作阶段通过。
- 新候选首轮 27/27、严格类型检查通过后继续加入 19 路由清单及 source/dist 装配验证。Koa 方法响应对照进一步确认 OPTIONS 及 404/405/501 的 charset/Content-Length 差异，新增断言先失败（`task5b-method-headers-red`），再以共享兼容文本响应修复。auth 查询核心改为明确抛错，旧入口保留日志/undefined 兼容映射，候选所有权中间件仍先处理失败为 403，不把下游错误误转为权限错误。
- 实现代理定向回归报告：Hono 110/110（含基础 app/routing、3B、3C、media、tag、5B），guarded 旧回归 86/86（含错误处理与既有路由清单），类型、构建、diff 检查退出 0；实际 source/dist 启动验证 3/3 通过，新增 history 查询、collect 权限拒绝、notification 接收者参数及返回结构断言。完整实现报告为证据目录中的 `task-5b-report.md`。
- 源码冻结后主代理独立运行 `pnpm type-check`、`pnpm build`、`pnpm test:hono`、`pnpm test` 和 `git diff --check`，全部退出 0；Hono **175 pass / 0 fail / 0 cancelled / 0 skipped**，旧套件 **777 pass / 0 fail / 0 cancelled / 0 skipped**。命令与输出见证据目录 `final-{type-check,build,hono,legacy,diff-check}.json/log`。此轮验证后交独立代理复审，结论见下节。

### 2026-11-17 Task 5B 完成与暂停

- 已完成 tag/history/collect/notification 共 **19 条路由**：tag 的 POST/GET `/tag`、GET/PUT `/tag/order`；history 的 POST/GET/DELETE `/history`、DELETE `/history/:articleId`、GET `/history/:articleId/check`；collect 的 POST `/collect`、GET `/collect/:userId`、POST/PATCH/DELETE `/collect/:collectId`、DELETE `/collect/:collectId/articles`；notification 的 GET `/notification`、GET `/notification/unread-count`、PATCH `/notification/read-all`、PATCH `/notification/:notificationId/read`。`test/http/task5b.test.ts` 对照冻结清单核对注册，并覆盖实际候选装配、隐式 HEAD 和关键成功/失败契约。
- history/collect/auth 使用可注入 TS 核心，旧 Koa 保留临时 CommonJS 桥；notification 复用既有共享 factory。认证身份、收藏所有权顺序、通知接收者条件、标签事务、历史分页/截断/封禁文案和收藏列表校验均与旧行为一致。共享查询参数 helper 从 user 提取复用，JSON/text 适配补齐 Koa charset/字节长度；未扩大到 5C 或改变旧业务顺序。
- **独立复审：Spec PASS / Quality Approved**，无剩余 Critical/Important/Minor 可执行项。复审读取本阶段起点快照、实际源码/测试、旧实现和完整验证日志，没有重复执行已新鲜通过的全套测试。报告已保存为证据目录的 `task-5b-review.md`；代理在报告落盘后遇到额度中断，主代理恢复后读取完整报告和明确结论，不将中断状态本身视为通过。
- 最终验证环境为 Node `v26.12.1` / pnpm `12.11.2`。类型检查、构建、Hono **175/175**、旧套件 **777/777** 及 diff 检查均通过；实际 source/dist 启动 **3/3** 已包含在 Hono 全套内。旧诊断和原生 TS 模块警告仍存在，不称无警告输出。直接 TS 与子进程使用 runtime guard，旧全套沿用 isolated-runtime；数据库只用 fake PG，未读取真实 env/密钥/业务媒体或连接外部服务。
- 与 5B 起点 **425 个文件**核对：**409 个字节不变、16 个有意修改、11 个新增、无删除**。16 个修改包含本计划及必要共享适配、旧桥和启动测试，package/锁文件和其他阶段业务文件未被改写。Git 分支与 HEAD 不变，Task 0–5B 和用户既有改动全部保留在本地未提交工作区。
- **本轮在 5B 完成后暂停，不进入 5C。** Task 5 整体仍未完成，下一执行单元为 5C（comment、draft、article）。未提交、push、合并、部署、切流或操作生产资源。最低 Node `22.22.2`、真实 PG/OAuth/Redis/R2/AI/FFmpeg 集成仍待验证；候选 readiness 保持 503，当前结果不是全量 API 上线验收。临时交接文件沿用 `/private/tmp/coderx-hono-task4a-handoff-cxicb18y.md` 并同步刷新；临时文件可能被系统清理，耐久状态以本计划为准。

### 2026-11-17 Task 5C 执行记录

- 用户明确授权开始 5C（comment、draft、article），本轮完成实现、隔离验证、独立复审和记录后暂停，不进入 5D。继续复用 `codex/hono-typescript-migration` / HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，仓库及祖先未发现适用 AGENTS.md，不新建 worktree。
- 起点 **436 个文件**内容和 SHA-256 已保存至 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task5c-ctc93_7w/`。保留全部 Task 0–5B 与用户未提交改动，继续以本计划为唯一账本，不覆盖旧 Flow 记录。
- 实际范围 **27 条路由**（comment 9、draft 4、article 14），包含 article 的 images/video 读取和随机 TOC 等静态路由优先级。按 comment 与 article/draft 两个实现单元推进，后者统一装配 bootstrap；共用候选自有 PG、通知 factory/publisher 和既有兼容适配。主代理负责旧行为核对、最终全量验证、独立复审与记录。
- 此处为进行中记录，不能据 5B 的通过结果宣称 5C 完成。仅使用隔离替身、临时文件及 loopback 监听；不连接真实外部服务，不操作生产资源，不提交或部署。
- 主代理 guarded 旧 controller/service/SQL/内容处理定向基线 **172/172**，退出 0（`baseline-legacy-targeted.log/json`）。随后审查发现其中既有 `article.controller.test.js` 的 Range 样本写入仓库 `public/video/phase4-range-<pid>.mp4` 并在结束时删除，目录拒绝测试还检查该根目录；这次基线实际发生了上述临时样本操作，不能称其全部使用系统临时目录。已要求将相关旧测试改为注入 os.tmpdir 路径并复验，未放宽 guard，未操作生产资源。
- 通过保存的旧 Controller、真实 Koa 路由/中间件及显式服务替身运行 loopback 探针（`legacy-probe.cjs/log/json`），退出 0；所有媒体样本均在系统临时目录，finally 清理。确认评论默认 limit 为 10、0 回退到 5，回复负数 limit 回退 10，重复 query 保留旧转换；文章标签非空成功的业务 code 实际为字符串 `标签保存成功`，字符串 tags 按字符迭代，缺 tags 为 500；公开文章详情即使带 JWT 也不自行添加历史。图片流不带 Content-Length，视频 416 保留 JSON 错误与 Content-Range。
- 共享封禁/维护中间件的 Koa charset/Content-Length 差异已先以 `shared-gates-red` 复现 **0/2**，再复用 `legacyJson` 修复。comment 与 article/draft 的实现红灯和后续结果另在各自报告中记录；最终全量验证及独立复审仍待完成。

### 2026-11-18 Task 5C 恢复检查点

- 两个实现单元已接入实际候选入口并冻结。comment 新 HTTP **8/8**、旧定向 **74/74**，article/draft 新 HTTP **8/8**、旧定向 **99/99**，共享中间件回归 **30/30**，真实源码与编译产物隔离启动 **3/3**。用例核对 27 条注册以及评论权限/通知、文章草稿事务、图片/视频响应。起点视频测试已迁移至系统临时目录。各套件有重叠，旧定向数不相加。
- 评论和回复写入事务内若读取新记录失败，现显式回滚并释放连接，避免发布未提交的通知。原 HTTP 200 业务失败响应保留，单独读取失败的兼容返回也保留。该行为经定向红灯/绿灯和候选 HTTP 验证。状态查询异常复验同时发现 CommonJS 日志模块的命名导入缺少 requestLogger，已改由默认导出取值并验证源码与编译产物。
- 恢复后启动独立复审和全量回归。主代理验证 `pnpm type-check`、`pnpm build` 与 `git diff --check` 退出 0。全部改动仍在当前分支，无提交。验收结果见下节。
- 首轮全量 Hono **193/193**。旧全套首轮 **766/767**，失败发生在测试夹具装配，夹具把新共享的文章文件检查与标签解析函数也替换成拒绝调用的代理。已仅让这两个依赖由调用方注入的帮助函数执行，其他服务仍隔离，旧 HTTP 契约复验 **12/12**，旧全套复验 **777/777**。这些结果对应复审修复前的代码。
- 独立复审发现新文章路由的路径形状重叠时，固定段归一化可能选择其他 HTTP 方法的路径并改变动态参数大小写。已交实现代理补旧 Koa 对照和回归，修订方法选择及 `Allow` 协商后复验。

### 2026-11-18 Task 5C 完成与暂停

- 完成 **27 条路由**，其中 comment 9 条、draft 4 条、article 14 条，清单测试逐项对照旧 Koa 注册。候选与旧入口共享评论、草稿、文章及媒体业务工厂。候选持有独立 PG、通知发布器和惰性 R2 客户端，使用显式媒体根目录。隔离测试覆盖认证、封禁和所有权顺序，评论及点赞事务提交后发布通知，草稿版本冲突、媒体绑定和发布时消费，文章删除后持久化清理，以及图片和视频的 Range/HEAD。
- 首轮复审定位路径形状重叠时的实例差异。补充旧 Koa 对照先复现失败，再按请求方法选择真实注册模板。保留参数大小写和单次解码，按原始路径与注册顺序生成 `Allow`。同时补登记同形状的公开收藏 GET 模板，覆盖此前 5B 行为。最终路由对照覆盖 **72 组请求**，定向回归 **109/109**。独立复验确认两个文章点赞路径均经过原认证，且 OPTIONS 包含正确方法。最终 **Spec PASS / Quality Approved**，无未解决阻塞项，报告见证据目录 `task-5c-review.md`。
- 最终验证使用 Node `v26.13.1` / pnpm `12.11.2`。冻结后 `pnpm test:hono` **194/194**（含实际源码和 dist 启动），`pnpm test` **777/777**，均无失败、取消或跳过。类型检查、构建、diff 检查退出 0。记录见 `postreview-*.json/log` 与 `article-routing-final-{typecheck,build}.json/log`。最终运行使用隔离替身、临时 env/密钥/媒体和 loopback 端口，真实外部服务与生产资源未使用。
- 与 5C 起点逐文件比对，共 **436 个既有文件**，**408 个字节不变、28 个有意修改、21 个新增、无删除**。分支 `codex/hono-typescript-migration` 与 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 保持，全部成果在本地工作区。已同步刷新临时交接，临时目录被清理时以本计划及实际源码为准。
- **本轮完成 5C 后暂停**。下一项为 5D（flow、flowDraft）。最低 Node `22.22.2` 和真实 PG/R2/Redis/OAuth/AI/FFmpeg 集成仍待验证，候选 readiness 保持 503。未提交、推送、合并、部署或操作生产资源。

### 2026-11-18 Task 5D 执行记录

- 用户授权开始 5D（flow、flowDraft）。完成实现、隔离验证和独立复审后暂停。继续使用分支 `codex/hono-typescript-migration` 和 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，保留既有未提交改动。
- 起点 **457 个文件**的内容和 SHA-256 已保存至 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task5d-cz735_jv/`。本轮范围为 **6 条路由**，Flow 3 条和 Flow 草稿 3 条。重点核对数字详情路由的严格匹配、草稿路径优先级、UUID 接受范围、幂等发布、草稿消费及媒体关联。验证使用临时资源和替身，真实外部服务与生产操作不在本轮范围。
- 编写实现前，用 runtime-guard 和 isolated-runtime 运行旧 controller/router/service/SQL 及 HTTP 契约，**156/156** 通过。隔离 Koa 探针记录了数字详情拒绝前导零、尾斜杠、大写路径、编码数字和原始点段的结果。超出安全整数的纯数字先匹配路由，再返回 HTTP 200 的参数错误。有效路径的 HEAD 保留 JSON 头，OPTIONS 返回 `HEAD, GET`。同一旧接口探针验证 UUID nil、max、v8 被接受，错误变体返回业务失败。证据见 `baseline-legacy-targeted` 和 `legacy-flow-probe` 日志。
- 真实源码候选入口的首条红灯针对尚未注册的数字详情：`GET /flow/42` 返回 404，预期 200。接入后同一断言通过。定向 Hono **20/20**，含 5D 的 Koa 对照、注入驱动事务测试和 5C 重叠路由回归。真实源码及编译产物的隔离启动 **3/3**，旧定向双 preload 回归 **173/173**。详见 `task-5d-report.md`、`5d-red`、`5d-source-green` 和 `final-targeted-legacy-guarded`。
- 源码冻结后，主代理运行 `pnpm type-check`、`pnpm build`、`git diff --check`、`pnpm test:hono`、`pnpm test`，全部退出 0。Node `v26.13.1` / pnpm `12.11.2`。Hono **199/199**、旧套件 **777/777**，均无失败、取消或跳过，命令及日志保存在 `final-*.json/log`。

### 2026-11-18 Task 5D 完成与暂停

- 完成 **6 条路由**。公开 Flow 列表和严格数字详情、经维护/认证/封禁检查的 Flow 发布，以及认证后的草稿查询、保存和删除由实际候选入口注册。数字详情使用具名约束，按原始 request target 匹配。仅普通 Flow 和草稿路径保留大小写与尾斜杠宽容，保留 HEAD、OPTIONS、方法协商和旧 JSON 头。
- Flow 业务抽出共用工厂，旧 Koa 继续通过 CommonJS 桥调用，候选注入自有 PG、媒体运行时和日志。草稿沿用共享工厂及服务端固定草稿类型。发布保留现有 UUID 接受范围和输入边界、幂等重试、草稿版本与媒体归属检查、提交后媒体处理。现有 SQL 和数据库结构未改。注入驱动测试验证调用参数和顺序，未实测 PostgreSQL 并发或真实仓储。
- **独立复审 Spec PASS / Quality Approved**，无待处理项。复审核对 6 条注册、路径和响应契约、工厂与旧服务的业务等价、SQL 与事务调用顺序。证据目录记录于上节，完整复审为 `task-5d-review.md`。
- 与 5D 起点比对，**457 个既有文件中 449 个字节不变、8 个有意修改、8 个新增、无删除**。保留分支 `codex/hono-typescript-migration` 与 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，成果留在本地工作区。交接文件已更新，临时证据缺失时以本计划和实际工作区为准。
- **本轮在 5D 完成后暂停，下一项为 5E**（avatar、image、media、video、ai）。最低 Node `22.22.2` 和真实外部集成仍待验证，readiness 保持 503。未提交、推送、部署或操作生产资源。

### 2026-11-18 Task 5E 执行记录

- 用户授权开始 5E。范围为 avatar、image、media、video、ai 的 14 条接口，复用已接入的图片上传及 AI 聊天，补齐 12 条并核对 Task 5 的 85 条旧路由。继续使用分支 `codex/hono-typescript-migration` 和 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`。
- 起点 **465 个文件**的内容及 SHA-256 保存至 `/var/folders/fz/br81bqt97_g6g6zppwn0plk40000gn/T/coderx-hono-task5e-pdkg97ae/`。guarded 旧定向基线 **94/94**。实际源码候选入口新增全量路由清单断言，首次运行确认为缺少 12 条预期路由，见 `5e-inventory-red`。
- 使用现有 Multer 在真实 Node IncomingMessage 上流式写普通头像、图片、视频，文件名带随机 UUID 并保留扩展名，避免原先同毫秒冲突。磁盘目录延迟到实际上传时创建。旧 Koa 探针确认意外文件字段走不同的原始路径大小写分支，适配改用原始路径后，测试验证同名批次、大小/类型/数量错误及失败文件清理，连同 prior routing 和 5D 验证 **14/14**。证据见 `legacy-upload-probe`、`5e-disk-first`、`5e-disk-green`。
- 头像删除旧路由只有登录检查，候选限制本人并沿用 403 权限错误，在调用文件与数据库服务前拒绝其他用户。正常本人删除的返回契约保留。这是本阶段明确的防误删修正。
- 实际源码候选的清单对照已通过 **85 条旧业务注册 / 16 组**，另有候选探活及就绪接口。匹配清单时显式映射 5A 已用的小写 `/user/checkauth` 及 5D 已用的具名数字约束，其余使用冻结清单原路径。实际 Node 启动验证检查新路由，包括视频元数据未命中、缺少视频文件、认证顺序、隔离模型目录下的 AI 健康响应。
- AI 旧新对照发现 POST-only 路径的 HEAD 405 应保留 Allow，省略 Content-Type 和 Content-Length。候选已按旧 Koa 行为处理，原聊天流另有取消与背压回归。媒体上传检查发现 COMMIT 已发出但确认丢失时不能安全判断文件是否已入库，故再验证头像、普通图片和视频文件在此情形保留；可确认未提交的失败仍清理临时文件。
- 源码冻结后，主代理执行 `pnpm test:hono` **219/219**、`pnpm test` **777/777**，均无失败、取消或跳过。`pnpm type-check`、`pnpm build`、`git diff --check` 退出 0。实际源码与编译产物均核对 85 条旧路由注册，见 `final-*.json/log`。各实现范围的定向结果及限制见同目录 `task-5e-images-report.md`、`task-5e-video-report.md`、`task-5e-ai-report.md`。
- 首次独立复审因会话额度中断，未保存结论。恢复后复核原始结果和冻结差异，由新的独立代理复审。最终结论见下节。

### 2026-11-18 Task 5E 完成与暂停

- 5E 的 **14 条路由**已验收，补齐头像上传/删除 2 条、普通图片上传/关联/删除 3 条、媒体图片删除 1 条、视频上传/关联/删除/状态查询 4 条、AI 健康/补全 2 条，复用已实现的媒体图片上传与 AI 聊天。Task 5 的 **16 组、85 条旧业务注册**均有映射。实际源码和编译产物逐项匹配冻结清单，另有候选探活及就绪接口。
- 实际 Node 适配以 Multer 流式处理普通磁盘上传，保留字段、文件数量与大小、MIME 判定、首张缩略图及错误响应。候选头像删除限制本人，旧 Koa 对照入口仍是历史登录规则。新磁盘文件在已发出 COMMIT 而确认丢失时保留，可确认未提交的失败仍清理。视频使用共享状态推进、元数据和封面处理、晋升和删除事务。候选关闭监听后等待已接收视频工作，再关闭数据库与媒体运行时。实际媒体外部集成留待单独环境验证。
- AI 健康与补全共享模型目录、SDK 调用、校验和限流，保留 SSE 聊天和取消行为。隔离旧新对照只归一化经检查的时间戳，并验证结构化补全请求和返回。旧 health/completion 专用 console 诊断随重复实现移除，保留既有聊天事件诊断。
- **最终独立复审 Spec PASS / Quality Approved**，无待修项。替代复审报告见证据目录 `task-5e-review.md`。最终隔离验证为 Node `v26.13.1` / pnpm `12.11.2`，Hono **219/219**、旧套件 **777/777**，无失败、取消或跳过。类型、构建、diff 检查通过。实际 source/dist 启动和资源关闭测试含在 Hono 套件。
- 与 5E 起点比对，**465 个既有文件，440 个字节不变、25 个有意修改、17 个新增、无删除**。分支 `codex/hono-typescript-migration` 和 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 保持。改动留在本地工作区，未提交、推送、部署或操作生产资源。
- **Task 5 本地验收完成，本轮暂停，下一项为 Task 6**。Task 6 的全套媒体生命周期专项仍待执行，包括异常中断/资源上限的进一步验证，以及已有 Flow 图片上传在提交确认丢失时的清理边界。Node `22.22.2`、真实 PostgreSQL、R2、FFmpeg 和 AI 供应方等集成未验证，readiness 保持 503。

### 2026-11-18 Task 6 完成与暂停

- 仅执行 Task 6。候选上传按实际流入的 multipart 字节计数并计入边界与字段开销。真实 Node 请求经锁定版 Multer 解析，普通图片、头像和视频以 pipeline 和文件系统背压落盘。磁盘与内存资源显式标记，文件用 UUID 加原扩展名独占创建。保持 `avatar`、`img`、`video`、`image` 字段、维护和认证顺序、同名文件顺序、首图 small 缩略图及 Flow 像素校验。
- 普通图保持 20 张 × 20 MiB，单视频保持 20 MiB，单 Flow 图保持 10 MiB。三条路由的总请求体分别为 401、21、11 MiB。头像历史只有单文件约束，候选增加 21 MiB 总请求体上限并保留原有 MIME 接收规则。超过总量返回 413，原有单文件和数量分支保留。附加表单字段限 32 个、每值 16 KiB、字段名 128 字符，并限制字段嵌套深度与数组下标。
- 解析失败会清理本次独占创建的文件。已写完文件会在 Multer 排空前移除，失败写入会关闭并清理，socket 中断及剩余写入由请求收尾。服务负责持久化后的归属。Flow 图片 COMMIT 确认丢失时保留原图与 small，可确认未提交时继续补偿。
- 头像、图片和视频保持各自路由和元数据规则。候选从已校验的常规文件描述符流式读取，拒绝路径穿越与叶节点符号链接。缺失或只剩数据库记录的头像及图片统一返回 404。保留原有 MIME、视频完整响应与 HEAD/206/416、长度及缓存头行为。请求中断和响应初始化失败均释放描述符。
- 视频任务从入库开始进入跟踪集合，客户端提前断开时仍完成已受理工作。关闭监听后排空在途入库、FFmpeg/ffprobe、封面、状态和晋升，再关闭 PG 与媒体运行时。关闭期限仍记录失败并设退出码，已开始的排空可以继续。保留 R2 晋升、事务互斥和本地回退。
- Node `v26.13.1` / pnpm `12.11.2`。类型、构建和 diff 检查通过，Hono **227/227**、旧套件 **778/778**（均无失败、取消或跳过），含源码和 dist 监听验证。真实 FFmpeg/ffprobe 9.0.2 **2/2**，覆盖亚秒封面、元数据及损坏视频失败分支。受控分块测试以 64 KiB 复用缓冲写入 40 和 240 MiB，最后一次采样的额外 Buffer 保留量约为 5.62 和 5.37 MiB。PostgreSQL 17.12 在一次性本地容器中通过 **15/15**，覆盖 Flow 并发、视频锁顺序、媒体对象与清理队列。容器、数据和本次下载的镜像已清理。
- 独立复审 **Spec PASS / Quality Approved**，无待修项。复审发现的拒收期间文件滞留与无效存储 MIME 时描述符泄漏均已修复并复测。证据在 `/private/tmp/coderx-hono-task6-6d69CB3O/`，含复审报告、日志、起点快照与相对起点差异。
- 起点 482 个文件中，466 个字节不变，16 个为本轮有意修改（含本计划），新增 7 个，无删除。分支 `codex/hono-typescript-migration` 和 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`。改动保留在本地，未提交或部署，测试仅用临时资源。真实 R2 与目标 Node `22.22.2` 待验证，readiness 保持 503。**本轮暂停，未开始 Task 7。**

### 2026-11-19 Task 7 完成与暂停

- 先迁常量、Result / BusinessError、纯工具、SQL 构建器和 PostgreSQL 接口，再迁文章、草稿、Flow、评论、用户、通知、视频、媒体晋升与清理，以及本地和 R2 存储适配器。旧 Koa 单例仍作为短期装配桥调用同一套 TypeScript 实现，Socket、采集、独立入口和最终 ESM 收敛由后续任务处理。
- PostgreSQL 保留查询行及字段、问号占位符、事务、RETURNING id、affectedRows 和安全 int8。明确的无效 PGPORT 在建池前报错。写入依赖的插入 ID 与草稿消费行数做运行时检查。结构化正文跳过无效媒体 URL 或封面字段，继续渲染其余内容。保留现有 SQL 执行和媒体加锁、晋升、删除及清理顺序。
- 业务和存储测试直接注入数据库、存储或通知依赖。三个 PostgreSQL 测试也改为注入各自的事务或 savepoint。分页、bcrypt、纯文本处理从旧 Koa 工具入口分离。新增两个锁定的开发类型依赖 @types/pg 8.23.1 和 @types/validator 13.15.10。
- 类型检查、构建和差异检查通过。Node 22.22.2 和 26.13.1 下各通过 Hono **227/227**、旧套件 **781/781**，无最终失败、取消或跳过，含候选源码与编译产物的真实监听回归。隔离 FFmpeg/ffprobe **2/2**。
- 一次性 PostgreSQL 17.12 容器内，以测试专用 schema 和迁移运行 **20/20**，涵盖视频锁顺序、Flow 并发与图片生命周期、已消费草稿的文章图片绑定、媒体对象及清理队列。实库适配器额外核对安全整数、问号参数、字段、插入结果和回滚。测试容器、数据与本轮下载的镜像已清理。真实 R2 待验证。
- 独立复审发现的编译产物残留 TypeScript 引用、测试事务注入、无效端口回退及写入结果和媒体属性校验均已处理并复测，无待修项。证据目录为 /private/tmp/coderx-hono-task7-2nmtiyb4/，包含 task-7-review.md、最终验证日志、起点快照和差异。
- 起点 489 个文件，228 个字节不变，194 个有意修改（含本计划），67 个从 JS 迁为同名 TS，另新增 5 个文件，无额外删除。分支 codex/hono-typescript-migration 和 HEAD 28a693d4a84b672039b1c5ac34d01d38eb2ff36d，保留未提交的既有工作。未部署或操作生产环境，readiness 保持 503。**本轮暂停，Task 8 尚未开始。**

### 2026-11-19 Task 8 完成与暂停

- Socket.IO、presence、Redis adapter 和通知总线已迁为 TypeScript。Socket 和 HTTP 共用 RS256 校验，保留原有 token 来源顺序、游客规则、user:<id> 房间、notification:new 业务载荷和 Redis 通知通道。独立 Socket 支持显式启动及关闭资源。完整 Socket 进程即使使用 memory presence 也需要 Redis 接收通知。Redis 初次连接失败会报告并退出。
- 每个 Socket 通知订阅者只向本实例的房间发送。临时 Redis 7.4.12 上用不含 src 的编译产物启动 3 个 Socket 实例并用真实 WebSocket 验证。共享前缀的两个实例上的客户端各收到一次，另一个前缀的实例独立接收，全部资源可关闭。Socket.IO adapter 的其他广播继续使用原通道。若将来更换 Socket 且启用 Redis adapter，同一前缀下的新旧 Socket 进程须错开。旧版跨实例广播与新版订阅送达重叠会重复通知。仅切换 HTTP 可以继续使用原 Socket 进程。
- 采集层和独立入口已迁移。INGEST_ENABLED 只控制定时 Worker，显式 CLI 保留原参数、输出、退出码、变更开关和事务顺序。Worker 退出会排空在途工作。临时 PostgreSQL 17.12 的采集媒体生命周期 1/1，使用测试方案与替身媒体存储，覆盖部分晋升、退休清理和文件名恢复。未读取真实订阅源或发布真实数据。
- 媒体 CLI 保留默认预演及显式 apply/repair。独立清理 Worker 由 CLEANUP_WORKER_ENABLED 显式启用，默认关闭。旧 Koa 入口仍承担现有调度。切换至独立 Worker 时须先结束旧调度并排空在途任务，保持 Hono 的 BACKGROUND_JOBS_ENABLED=false，再启用独立 Worker。现阶段沿用旧 Koa 为唯一清理执行方，不依赖 cron 进程内互斥协调不同进程。
- Socket、采集 Worker/CLI、媒体 CLI、清理 Worker 和密钥工具均可编译。本阶段兼容脚本继续使用 tsx 源码入口，独立清理提供源码和 dist 脚本。编译产物验证使用隔离目录和显式临时密钥配置。导入源码或编译的密钥工具均不生成密钥。新增锁定开发类型依赖 @types/xml2js 0.4.14。
- 类型检查、构建与 diff 检查通过。Node 22.22.2 和 26.13.1 下均通过迁移套件 **287/287**、旧套件 **738/738**，无失败、取消或跳过。部分既有清理测试迁入 TypeScript 套件。复审的通知混合版本、清理归属和 Redis 依赖均写入交接。验证日志和 task-8-review.md 位于 /private/tmp/coderx-hono-task8-qDA5mRfn/。
- 起点 494 个文件，382 个字节不变，52 个有意修改（含本计划），58 个 JS 迁为同名 TS（包含测试），新增 11 个。两处被替换的旧文件为 Socket 鉴权单例和清理声明 shim。当前分支 codex/hono-typescript-migration，HEAD 28a693d4a84b672039b1c5ac34d01d38eb2ff36d。临时 PostgreSQL/Redis 容器和本轮下载的镜像已清理，既有开发容器与生产环境未操作。真实 R2 与真实采集集成待验，readiness 保持 503。**本轮暂停，Task 9 尚未开始。**

### 2026-11-19 本机 PostgreSQL 容器调整记录

- 用户确认 Docker Desktop 中的 `pg-before-upgrade-20261027-174349` 是上次 PostgreSQL 升级后保留的旧容器。当前本机开发容器为 `pg`。
- 状态为待验证后移除。完成 Koa → Hono 重构后，使用当前 `pg` 验证 Hono 能正常连接及执行业务查询、事务，确认旧容器不再作为升级回退或数据恢复来源。条件满足后，仅移除指定的旧容器，保留当前 `pg` 和现有数据卷。Task 9 仍用独立临时资源验证。本轮不以临时数据库通过替代当前 `pg` 验证。

### 2026-11-19 Task 9 完成与暂停

- HTTP 入口统一为 `src/main.ts` 和 `dist/main.js`。Hono 路由、控制器和中间件回到各自职责目录。业务源码统一为严格 TypeScript ESM，移除了 Koa HTTP 实现、CommonJS 装配桥、module-alias 和 jsconfig，回滚使用旧发布版。保留独立 Multer 2.4 以维持现有流式上传限制、背压与中断清理。
- `pnpm test` 先清理并构建，再运行服务、任务、控制器和 HTTP 测试。Node 22.22.2 和 26.13.1 均 **886/886**，无失败、跳过或取消。迁移期重复的 Koa 断言并入 Hono 套件，使用移除旧实现前捕获的 324 条响应，核对 16 个模块的 85 条业务路由、12 条维护开关的顺序和 2 个健康检查端点。
- `pnpm type-check` 涵盖全部业务源码及 49 个测试文件，保留此前检查的 45 个 TypeScript 测试。另有 93 个原 JavaScript 服务、任务及集成测试文件迁为 TS/ESM，动态替身及行为仍由运行验证；这些文件尚未纳入严格静态检查。
- 清理构建后有 203 个业务 JS 文件，与源码实现一一对应。独立目录用锁文件安装运行时依赖，不包含 `src` 或开发依赖。两个 Node 版本均验证 HTTP、Socket.IO 与采集 Worker 的启动和 SIGTERM 退出、缺少指定环境文件或密钥时启动失败、两个 CLI 的无效命令，以及默认关闭的清理 Worker。HTTP liveness 为 200，readiness 保持 503。独立发布版显式配置 JWT 路径，兼顾旧检出目录中原有的密钥路径。
- 临时 PostgreSQL 18.3 的事务、媒体生命周期与并发集成通过 **21/21**。真实 FFmpeg/ffprobe 在两个版本各 **2/2**。临时 Redis 8.6.1 搭配无源码产物验证同前缀单次投递、不同前缀隔离和资源关闭。PM2 7.1.2 加载 3 项现有进程配置，未启动守护进程。用临时替身验证两条旧部署配方会在构建失败时中止。
- 独立复审通过。起点的 503 个文件中，117 个字节一致，149 个有意修改，139 个迁移路径或扩展名，98 个旧实现及过渡测试文件退出，另新增 10 个文件。既有工作保留在 `codex/hono-typescript-migration`，HEAD 为 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`。复审、覆盖对应表、构建与测试日志见 `/private/tmp/coderx-hono-task9-ccRRVh22/`。临时 PostgreSQL 和 Redis 容器已清理。当前 `pg` 及升级遗留容器仍待按调整记录处理。真实 R2 与实际外部采集保留待验。**本轮暂停，Task 10 尚未开始，未部署。**


### 2026-11-19 Task 10 完成与暂停

- 新增独立候选 [PM2 配置](../../../deploy/ecosystem.hono.config.cjs)、[Nginx 示例](../../../deploy/nginx.hono.example)和[发布手册](../../../deploy/README.md)，并补上 `just deploy-hono`。PM2 只启动 `coderx_hono_candidate`，用 Node 直接执行编译入口，绑定 loopback，关闭应用内调度。显式校验 release、环境文件和端口，候选日志写入 release。应用排空时限由启动 shell 控制，PM2 的强制结束时限比它多 5000 毫秒。
- 本阶段选择关闭 PM2 `wait_ready`，独立观测进程状态和 HTTP 就绪。readiness 以有界、单飞的只读 PostgreSQL `SELECT 1` 检查连接和查询，失败返回 503；liveness 独立，两者均要求禁止缓存。SIGINT、SIGTERM 和监听关闭共享同一个结束流程，处理器保留至排空结束。回归测试先复现排空期间重复信号造成的提前终止，再验证收尾只执行一次。
- Node 26.13.1 / pnpm 12.11.2 的 `pnpm type-check`、`pnpm build` 和 guarded `pnpm test` 通过，**888/888**。Node 22.22.2 guarded 配置、生命周期和入口定向测试 **17/17**。两套均无失败/跳过。无源码 release 从锁文件离线安装运行时依赖，Node 22.22.2、PM2 7.1.2、Nginx 1.28.3 实测启动和恢复，候选 SIGINT 与 SIGTERM 均正常退出，未发现强制结束。Nginx 两条 API 入口、Socket 路由升级 101、超聚合上传 413，以及停止时 502、恢复后 200 均核对。
- PostgreSQL 镜像下载失败，本阶段以新建 loopback 协议夹具验证真实 Node 驱动执行 `SELECT 1`，以及连接拒绝、查询超时与恢复。liveness 保持 200，readiness 为 200 → 503 → 200。Socket 代理使用隔离上游夹具。Task 9 真实临时 PostgreSQL / Redis 验收仍按原记录，真实数据库认证、Socket/R2/AI/OAuth 与线上配置不在本轮演练结论内。演练的 Nginx、PM2、各夹具、密钥和监听均已清理。
- 独立复审通过，修正了 PM2 的 ESM 包装入口、probe 总时限与 socket 回收、Nginx 的 Socket 心跳空闲期限和停止后恢复的 shell 断言。证据在 `/private/tmp/coderx-hono-task10-dW4h4jNR/`，含 `task-10-review.md`、`full26-final.log`、`targeted22.log`、`rehearsal-verified22.log` 和 `preservation.json`。
- 本地演练制品 `local-uncommitted.tar.gz` 的 SHA-256 为 `0e699e0b465d5a3d198f03ea5e2850beeff0feb2cb9f8281fc4976c67df68481`，buildId 为 `task10-local-uncommitted`。源基线为 `codex/hono-typescript-migration` 的 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`，实际制品来自本地未提交工作区。起点 415 个文件中 406 个字节一致，9 个按本阶段需要更新，另新增 4 个，无删除。只有临时 loopback 代理流量。**本轮暂停，未开始 Task 11。未部署、切流或操作生产及既有 PostgreSQL、Redis、旧 PG 容器。**



### 2026-11-20 Task 11 本地最终验收与交接

- Node 22.22.2 与 26.13.1 均用 pnpm 12.11.2 执行 `pnpm type-check`、`pnpm build`、`pnpm test`。全套各 **888/888**，无失败、取消或跳过。源码与编译产物均核对 16 个模块、85 条业务路由及 2 个健康端点，验证 324 条冻结响应、12 条维护开关顺序、真实 Node multipart、AI 流与取消、Range。单独运行 `test/integration/multipartMemory.test.ts` 并启用 `--expose-gc`，两版 Node 各 **1/1**，通过 240 MiB 流式批量传输的 Buffer 保留量断言。
- 以新建临时 PostgreSQL 18.3 和最小业务 Schema 执行 `test/integration/*.postgres.test.ts`，只在该库装配必要的增量迁移。Node 22 **21/21**，覆盖事务、幂等、媒体删除与并发。两版 Node 的无源码 HTTP 均经真实 PostgreSQL 验证 liveness 200、可用连接 readiness 200、拒绝认证 readiness 503。PM2 7.1.2、Nginx 1.28.3 与另一新建临时 PostgreSQL 再演练断开和恢复，readiness 为 200 → 503 → 200，代理在候选停止和恢复时分别为 502 和 200。
- 无源码 release 使用锁文件装配运行时依赖，203 个编译模块与源码对应。两版 Node 覆盖 HTTP、Socket.IO、采集 Worker 的 SIGTERM，坏端口、显式指定的环境文件不存在、缺密钥时启动失败，采集/媒体 CLI 对无效命令退出，以及清理 Worker 默认关闭。独立 Redis 8.6.1 在两版 Node 验证实际 Redis 订阅与 Socket.IO 推送，同一前缀对每个 Socket 投递一次、不同前缀隔离。
- FFmpeg/ffprobe 9.0.2 使用临时视频，两版 Node 各 **2/2**。R2 用 S3 客户端替身验证对象与状态语义，AI 用流式夹具验证 SDK 输出、取消及背压，Google/GitHub 用 OAuth 替身验证登录与回调。真实 R2/CDN、模型、OAuth、外部采集和部署目标仍待现场核对。
- 无新增业务 DDL，`src` 无运行时 JS。独立复审对照冻结 API 清单及退役测试覆盖映射，核对无不在预期内的 API 或覆盖变化。严格检查包含全体业务源码以及 tsconfig 指定的测试。候选文件凭据扫描命中的 9 条记录均为占位、类型判断或合成测试数据，最终压缩包按路径和清单核查，不包含业务媒体或密钥。工作区既有改动保留，Task 11 仅更新 4 份仓库文档。
- 当前分支 `codex/hono-typescript-migration`，基线 HEAD `28a693d4a84b672039b1c5ac34d01d38eb2ff36d`。本地未提交候选 `task11-local-8cba3591e13f` 来自 Node 22.22.2 clean build，制品 `coderx-task11-local.tar.gz` 的 SHA-256 为 `561eb364610ca5a3e816e06be4104257500086442b0e1c306f5b1a40e5182ff4`。构建清单、制品、复审及测试日志在 `/private/tmp/coderx-hono-task11-bLVWe3gq/`。该目录只保存本地验收证据和制品，正式发布仍从批准的提交构建。
- 临时 PostgreSQL、Redis、PM2、Nginx 及相关密钥、端口均已清理。**本地迁移收尾完成，停在 Task 12 前。** 已有服务和生产环境未操作。Task 12 审核目标机版本、实际依赖与 Schema、新旧共享媒体、排空时限及 Nginx 配置后，再按授权步骤部署和切流。


### 2026-11-20 Task 12A 目标机只读核查

- 经确认以 `admin` 连接 SSH 别名 `aws`，用非交互 `sudo -n` 核对业务端口归属和文件元数据。目标机为 Debian 13 arm64，2 核。首次采样时可用内存约 904 MiB，无 swap，根分区可用约 14 GiB。
- 目标机默认 Node 24.12.0、pnpm 10.27.0、PM2 6.0.14、Nginx 1.26.3。项目的 Node 24 最低版本为 24.15.0，锁定 pnpm 12.11.2；Task 11 已验收 Node 22.22.2。部署候选前需为候选单独确定兼容的运行时。
- Nginx 磁盘配置引用 localhost 的 8000 和 8001。监听进程分别运行 `./src/main.js` 和 `./src/socket_server.js`，均以 root 身份使用 `/usr/local/bin/node`，工作目录均为 `/root/coderx_server`。该目录的 `main` HEAD 为 `1eb6d156392255094988fd51a12b1b4fd9f02276`。本地迁移基线 `28a693d4a84b672039b1c5ac34d01d38eb2ff36d` 在其后 4 个提交。此处记录的是工作目录的 HEAD，整棵线上工作树与提交的一致性未经验证。
- 线上路径配置源码与本地旧版基线指纹一致。以工作目录为基准，已核实 `public/avatar`、`public/img`、`public/video` 三个目录及 `src/app/keys/{private,public}.key` 两个常规文件的实际路径。JWT 仅检查路径和元数据。
- 交接点为 12A 第二项。待确定经批准的候选提交、隔离资源与写入窗口。现有服务持续运行，本次未部署或切流，未连接 PostgreSQL、Redis 或操作旧 PG 容器。

## 2. 技术路线和文件职责

### 2.1 版本与模块边界

2026-11-10 查询 TypeScript 标准包 stable/latest 为 7.0.2；Hono v5 官方迁移页当时仍指向 RC。实施时重新查询 registry、官方 release、peer dependencies，记录实际版本，使用稳定版本，不装 `@next`。本文 Hono 示例以稳定 v4 风格为基准；若稳定主版本已变化，核对 onError 等 API，再以行为验收为准调整。

初期保持根 package 的 CommonJS 语义，NodeNext 编译配合 allowJs。新 Hono 路由临时放 `src/http/router`，避免旧自动扫描路由工具误加载 TS 文件。旧 Koa 只用于本地对照，线上旧 release 不变。

`src/main.hono.ts` 先加载环境和运行时 alias，再动态加载生产依赖。源码启动时 `@` 指向 src，编译产物启动时指向 dist；不能让 dist 回头加载 src。最终统一 ESM、相对 `.js` import（TS NodeNext 对应解析 `.ts`），移除 alias；用户要求保留的是文件命名，不是 `@/` 拼写。

### 2.2 文件清单

| 文件/范围                                                                                 | 职责                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `src/main.js` → `src/main.ts`                                                             | 最终 HTTP 启动、生产依赖装配、Node server、退出 |
| `src/main.hono.ts`（临时）                                                                | 兼容期候选入口，最终合并为 main.ts              |
| `src/app/koaApp.js`（临时）                                                               | 旧应用无 listen/cron/AI 探测的对照 factory      |
| `src/http/app.ts`、`types.ts`                                                             | 纯 Hono factory 和请求上下文契约                |
| `src/http/registerRoutes.ts`、`dependencies.ts`                                           | 显式路由注册与生产依赖装配，不扫描目录          |
| `src/http/router/*.router.ts`（临时）                                                     | 新路由，验收后移回 `src/router`                 |
| `src/http/controller/*.controller.ts`（临时）                                             | 薄处理器，验收后移回 `src/controller`           |
| `src/http/middleware/*.middleware.ts`（临时）                                             | 新中间件，验收后移回 `src/middleware`           |
| `src/app/runtime.config.ts`、`loadEnvironment.ts`                                         | 纯配置解析和入口环境加载                        |
| `src/app/shutdown.ts`                                                                     | 请求排空、后台视频任务追踪、连接和日志关闭      |
| `src/app/Result.js`、`src/errors/BusinessError.js` → `.ts`                                | 泛型响应与业务错误，序列化保持兼容              |
| `src/app/database.js`、`src/app/database/*.js` → `.ts`                                    | PG 查询、变更结果、连接和事务类型               |
| `src/service/**/*.js`、`src/storage/*.js`、`src/utils/*.js`、`src/constants/*.js` → `.ts` | 业务、SQL、存储、工具及常量                     |
| `src/socket_server.js`、`src/socket/**/*.js` → `.ts`                                      | Socket.IO、presence、Redis 和通知               |
| `src/ingest/**/*.js`、`src/tasks/*.js` → `.ts`                                            | 采集、CLI、媒体迁移与清理                       |
| `src/tasks/cleanup.worker.ts`                                                             | 新独立清理入口，HTTP 不默认拥有调度             |
| `src/app/keys/generate-keys.js` → `.ts`                                                   | 迁移工具代码，不实际生成密钥                    |
| `test/http/*.test.ts`                                                                     | HTTP 契约和真实 Node adapter 测试               |
| `test/fixtures/http-contracts.json`                                                       | 无凭据的路由及代表性输入输出清单                |
| `test/service`、`test/controller`、`test/tasks`、`test/integration`                       | 保留并迁移既有测试                              |
| `deploy/ecosystem.hono.config.cjs`                                                        | 单独的新 HTTP PM2 配置                          |
| `deploy/nginx.hono.example`、`deploy/README.md`                                           | 可审查的代理示例、部署/切流/回滚手册            |

### 2.3 依赖决策

- 增加 Hono、`@hono/node-server`、`@hono/zod-validator`；开发工具 TypeScript 7、tsx、`@types/node` 以及确实缺声明的库类型。先确认自带类型，避免重复安装。
- 保留现有 pg、Zod、jsonwebtoken、log4js、Socket.IO、Redis、AI/S3 SDK、图像处理和 node-cron。
- 普通批量图片/视频使用流式落盘；默认评估 Node IncomingMessage + busboy 适配器，核对版本与类型，不用整个请求的 formData/arrayBuffer 替代磁盘链路。
- 完成全入口迁移后移除 koa、@koa/router、@koa/cors、koa-bodyparser、@koa/multer 和 module-alias。Task 9 保留 Task 6 选用的独立 Multer 2.4 解析器。它接收 Node 请求流并支持现有上传的背压、大小限制、中断和临时文件清理。依赖与 Koa 无关。
- validator 的 Flow UUID 判断只有在接受范围/错误契约一致时才改成 Zod 并删包；dotenv/JWT/日志不为减少依赖而强制更换。

## 3. 执行任务

### Task 0：固定外部契约并重建基线

**Files:** 读取 README、HONO_MIGRATION、package、router/controller/middleware、FLOW_PUBLICATION、CONTENT_INGEST；创建 `test/fixtures/http-contracts.json`、`test/http/legacy.contract.test.js`；必要时从 main 提取 `src/app/koaApp.js`。

**Interfaces:** `createKoaApp()` 用于对照，不绑定端口、不启动任务；外部依赖用 fake 注入，测试需要时绑定端口 0，finally 关闭。

- [x] 检查 Git 状态、HEAD、适用 AGENTS，创建/复用迁移分支；不 reset/clean，不覆盖未提交计划和用户改动。
- [x] 执行 `node --version`、`pnpm --version`、`pnpm test`，记录实际结果；已有失败单列，不删用例掩盖。
- [x] 按实际路由登记 method/path、参数、认证/封禁/权限顺序、body 类型、状态/业务 code、媒体/SSE、限流/维护规则，排除注释里的旧路由。
- [x] 固定 JSON、鉴权、multipart、AI、Range、Flow 动态路径的代表性成功与错误响应。包括尾斜杠、HEAD/OPTIONS/405/Allow、畸形 JSON、重复 query、undefined 字段序列化、OAuth Location。
- [x] 只用 fake 数据或临时资源；确认导入对照 factory 不执行清理、AI 探测或网络监听；提取入口后重跑基线。

验收：清单来源明确，默认测试通过；对照不会连接真实 PG/R2/AI 或读取真实密钥。该清单是后续逐模块验收依据。

### Task 1：TS7 编译、测试和兼容入口

**Files:** `package.json`、`pnpm-lock.yaml`、`jsconfig.json`；新建 `tsconfig.json`、`tsconfig.build.json`、`src/main.hono.ts`、`test/http/toolchain.test.ts`。

**Interfaces:** type-check 检查源码和测试；build 只将 src 编译到 dist；dev:hono 运行源码，start:hono 用纯 Node 运行产物。

- [x] 核验稳定版本与 peer dependencies，安装必要包并记录版本，不整体升级无关依赖。
- [x] 使用以下配置起步，不复制 TS7 已移除的 baseUrl；根 package 暂不启用 type:module。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "allowJs": true,
    "checkJs": false,
    "noEmit": true,
    "types": ["node"],
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist", "docs"]
}
```

`tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "noEmitOnError": true,
    "rootDir": "./src",
    "outDir": "./dist",
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "docs"]
}
```

- [x] 保留旧 dev/start 对照，新增如下 scripts；test:hono 初期覆盖新 TS 测试，最终纳入默认 test。

```json
{
  "dev:hono": "NODE_ENV=development tsx watch ./src/main.hono.ts",
  "start:hono": "NODE_ENV=production node --enable-source-maps ./dist/main.hono.js",
  "type-check": "tsc -p tsconfig.json",
  "build": "tsc -p tsconfig.build.json",
  "test:hono": "node --import=tsx --test --test-concurrency=1 \"test/http/*.test.ts\""
}
```

- [x] 入口先初始化 env/alias 再动态 import；用 source/dist 两种 smoke 检查真实模块路径，不依赖 tsx 修补生产 alias。
- [x] 执行 `pnpm type-check`、`pnpm build`、`pnpm test`、`pnpm test:hono`；产物不复制密钥/env/public 媒体。

验收：构建和类型检查可以阻止错误发布；编译后的 smoke 用纯 Node 成功。空壳入口只是本阶段交付，不算迁移完成。

### Task 2：配置、存储路径和启动副作用隔离

**Files:** 新建 runtime.config/loadEnvironment/shutdown；修改 `src/app/config.js`、`src/constants/filePaths.js`、`src/app/logger.js`、`src/tasks/cleanOrphanFiles.js`、video controller、localMediaCleanup service、`.env.example`；新增 `test/http/runtime.config.test.ts`、`test/tasks/backgroundJobs.test.ts`。

**Interfaces:** 纯 `parseBackgroundJobsEnabled(value: string | undefined): boolean`；配置包含 env 文件、host/port、mediaRoot、密钥路径、logRoot、buildId、shutdownTimeoutMs；shutdown 接受资源 close 回调和任务集合。

- [x] 先建立开关测试；未设置默认 false，只有明确 true 才创建/启动任务，非法值启动失败。

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackgroundJobsEnabled } from '../../src/app/runtime.config.js';

test('candidate HTTP defaults to no background jobs', () => {
  assert.equal(parseBackgroundJobsEnabled(undefined), false);
  assert.equal(parseBackgroundJobsEnabled('false'), false);
  assert.equal(parseBackgroundJobsEnabled('true'), true);
  assert.throws(() => parseBackgroundJobsEnabled('treu'));
});
```

```ts
export function parseBackgroundJobsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('BACKGROUND_JOBS_ENABLED must be true or false');
}
```

- [x] 将清理模块 import-time cron.schedule 改成显式 factory；关闭时不创建 cron、不调用 processPending。现有 start 会立即清理；仅删 start 不足以证明无副作用，要核对已安装 node-cron 语义。
- [x] 新增 `APP_ENV_FILE`、`MEDIA_ROOT`、`JWT_PRIVATE_KEY_PATH`、`JWT_PUBLIC_KEY_PATH`、`LOG_ROOT`、`BACKGROUND_JOBS_ENABLED`、`BUILD_ID`、`SHUTDOWN_TIMEOUT_MS`，先加载所选 env 再初始化其他依赖；配置错误不输出凭据。
- [x] 新候选默认 host=127.0.0.1；端口显式配置。MEDIA_ROOT 下统一 avatar/img/video；查找读取、转码、清理、库存、迁移工具散落的 ./public 假设并统一。
- [x] LocalMediaStore 会拒绝符号链接及不可信目录权限；共享媒体用明确绝对路径，不绕过校验。测试 source/dist 使用相同配置得到相同存储路径。
- [x] 启动才读取配置指定的密钥；不自动生成。最终隔离测试在临时目录创建并清理密钥，不访问仓库当前密钥；此前两次隔离失误见执行记录。
- [x] 用 fake cron/cleanup 验证 import、app factory 均无任务和外部连接副作用。旧对照若保留调度，由旧入口显式开启；线上旧 release 不变。

验收：候选不会执行清理；配置和资源路径测试通过；没有导入即连接 PG/R2/AI 的隐藏行为。

### Task 3：HTTP 外壳、错误与认证

**Files:** `src/http/{app,types,dependencies,registerRoutes}.ts`；`src/http/middleware/{auth,error,logger,mediaMaintenance,ai}.middleware.ts`；`test/http/{app,auth,error,cors,routing}.test.ts`。

**子阶段约定（2026-11-12 用户确认）：**

- [x] **3A：应用工厂与基础 HTTP 行为。** 纯 factory、类型与显式依赖/路由装配；live/ready 和超时；CORS；404/405/Allow/OPTIONS/HEAD、尾斜杠、路径优先级；离线与 source/dist 验证。完成后可暂停。
- [x] **3B：请求解析、错误与日志。** JSON/form/text 解析及大小限制；BusinessError/旧 errorTypes/JSON/上传/维护错误的 Result 映射；日志最终状态和脱敏。
- [x] **3C：认证、权限与 AI 限流。** JWT/RS256、用户上下文、封禁/权限、HTTP/Socket 判定一致、下游错误不误转 401；AI 限流、代理/IP；完成 Task 3 整体验收。

下方原始验收条目继续保留；跨阶段条目（例如 CORS/日志/onError）只有全部完成后才勾选。3A 不挂载真实业务路由或连接 PG；候选在尚未装配真实 readiness 检查时返回 503，避免把基础入口可启动误称为业务就绪。

**Interfaces:** `createHttpApp(options: HttpAppOptions): Hono<AppEnv>` 仅依赖显式路由装配和 readiness，不导入真实环境实例。下方是原始基础示例；3C 已按旧验证器行为扩展 AuthUser 为真实 payload 联合，实际接口以 `src/http/types.ts` 与上述完成记录为准：

```ts
import type { Hono } from 'hono';
export interface AuthUser {
  id: number;
  name?: string;
  iat?: number;
  exp?: number;
}
export type AppEnv = { Variables: { user: AuthUser } };
export interface HttpAppOptions {
  buildId: string;
  checkReady: () => Promise<boolean>;
  registerRoutes: (app: Hono<AppEnv>) => void;
}
```

- [x] 新增 GET /health/live（200、status/buildId）与 GET /health/ready（依赖就绪200，否则503）；probe 有超时、无写入，不调用 AI 生成服务。

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../src/http/app.js';

test('readiness reflects unavailable dependencies', async () => {
  const app = createHttpApp({
    buildId: 'test-build',
    checkReady: async () => false,
    registerRoutes() {},
  });
  assert.equal((await app.request('/health/live')).status, 200);
  assert.equal((await app.request('/health/ready')).status, 503);
});
```

- [x] 实现 CORS、日志、集中 onError；映射 BusinessError、旧 errorTypes、JSON/上传/维护错误到原 Result 格式。保留脱敏，不记录 JWT/密码/完整 AI 上下文。
- [x] 核对当前 bodyparser 的 JSON/form/text 大小限制、Content-Type 和空 body/畸形 body 行为，显式复现所需契约；不能删除解析器后同时丢掉请求体限制。
- [x] 不机械照搬 Koa 的 try/catch。测试下游 400/500 不被认证中间件误变成401；验证最终状态也被日志正确记录。
- [x] 保留 jsonwebtoken/RS256/payload/exp；使用 c.set/get 存储用户，资源权限与封禁继续调用原业务服务。
- [x] 用临时密钥验证缺 token、过期、错误算法、有效旧 token、封禁、无权限与下游异常；HTTP 与 Socket 判定一致。
- [x] 对照处理 404/405/Allow/OPTIONS/HEAD、尾斜杠与路径优先级；若已锁定 Hono 无所需内置 API，写小型兼容层，不混用其他版本文档。
- [x] 保留 AI 限流窗口/次数/响应；核对受信代理与真实 IP，不盲信客户端 X-Forwarded-For；记录并行实例各自内存限流的差异。

验收：HTTP 基础测试离线通过；factory 可独立实例化；生产依赖只由入口装配。

### Task 4：普通 JSON、上传、AI 流先行验证

**Files:** `src/http/router/{tag,media,ai}.router.ts`、对应薄 controller；tag/mediaImage/ai service；`test/http/{tag,media,aiStream}.test.ts`。

**Interfaces:** 路由 factory 显式接收 service/auth/upload 依赖；Service 接收普通参数。媒体输出适配现有 buffer 元数据；AI 接口保留 SDK result。

#### 2026-11-13 子阶段约定

用户通过 `/tmp/coderx-hono-task4a-handoff-cxicb18y.md` 交接并确认以下拆分。本次只执行 **4A**，完成实现、验证、必要复审和计划记录后暂停；不自动进入 4B。保留下方原始验收条目，只有对应范围全部验收后才勾选。

- [x] **4A 标签 JSON 链路：** 标签列表、创建、顺序读取/更新；保持分页/响应和单事务语义；对应类型、构建、回归及复审通过后可暂停。
- [x] **4B 图片上传解析：** image 字段、10MiB、类型/像素校验、维护/认证顺序、失败清理；上传适配层可独立测试，图片接口暂不算完整完成。
- [x] **4C 图片业务链路：** 接通 /media/images controller/service、元数据、pending 状态与成功/失败响应；完整图片链路的本地契约和真实 Node 上传验证通过。
- [x] **4D AI 流输出：** 接通 /ai/chat、SDK UIMessage 流、响应前后错误、不整体缓冲；正常流与错误路径通过，取消专项留给 4E。
- [x] **4E AI 取消与整体验收：** 客户端断开、SDK 停止生成、背压、资源关闭、三链路联合验收；完成 Task 4 本地整体验收（真实集成与 Node 22 待验）。

4B/4C 仅处理先行图片链路；批量上传、视频和完整媒体迁移仍属于 Task 6。

2026-11-13 用户在 4A 完成后明确要求“4B开始”：当前仅授权 4B，完成实现、隔离验证、必要复审和记录后暂停，不自动进入 4C。4A 的暂停说明保留为历史记录。

2026-11-14 用户明确继续 **4C**，完成实现、隔离验证、必要复审和计划记录后暂停；不进入 4D。上方 4A/4B 暂停说明保留为历史记录。

2026-11-14 用户在确认 4C 完成后要求继续：本轮执行 **4D**，完成后暂停，不进入 4E。前述暂停说明为历史记录。

2026-11-14 用户在 4D 后再次要求继续：本轮执行 **4E**，完成 Task 4 本地联合验收后暂停，不进入 Task 5。

原始验收条目：

- [x] GET /tag 验证分页默认值和 Result；继续迁移创建、顺序读取/更新，顺序更新保持单事务。
- [x] POST /media/images 验证 image 字段、鉴权、10MiB、JPEG/PNG/WebP、像素限制、pending 生命周期与响应；真实上传 service 接收原有元数据，DB 边界使用替身（4B/4C；真实 PG/R2 未验证）。
- [x] POST /ai/chat 返回 result.toUIMessageStreamResponse() 的 Web Response body/headers，并保留 Hono CORS；不转换为自定义 SSE，不先读完整流。
- [x] 测试 headers 前错误、输出后错误、客户端 abort；把取消信号传到 SDK 支持的 abort 选项，验证取消确实停止下游生成（真实 SDK 与受控本地 provider，非远程 Ollama 生成验收）。
- [x] 除 app.request 外，使用真实 Node adapter 绑定 127.0.0.1:0 验证 multipart、流取消/背压/close，finally 关闭 server/client/reader。

验收：三条纵向链路通过后再扩大迁移；若出现模块桥接/类型设计问题先修正，不复制到全部模块。

### Task 5：分组迁移全部路由和 Controller

**Files:** 下表每个 `src/router/<name>.router.js`、`src/controller/<name>.controller.js` 对应临时 Hono TS；同步迁移 test/controller 行为断言及 test/http 契约。

**Interfaces:** 显式子路由导出，薄处理器使用类型 factory；Service 不接收 Context，不以 Context<any> 丢弃推导；不要求前端同时改用 RPC。

| 顺序 | 模块（覆盖16个）                    | 重点行为                                                       |
| ---- | ----------------------------------- | -------------------------------------------------------------- |
| A    | user、oauth                         | 注册/登录/资料/关注/举报/头像读取、Google/GitHub、Token/回跳   |
| B    | tag、history、collect、notification | 标签顺序、浏览、收藏权限、通知分页/未读/已读及事务             |
| C    | comment、draft、article             | 评论回复/点赞、草稿、文章发布/更新/删除/标签/浏览/随机TOC      |
| D    | flow、flowDraft                     | UUID接受范围、clientRequestId幂等、feed/detail、草稿/媒体关联  |
| E    | avatar、image、media、video、ai     | 上传/读取/关联/删除、维护、视频状态、AI health/chat/completion |

- [x] 5A：user、oauth 已完成实现、隔离验证、独立复审和计划记录（2026-11-16）；19 条实际路由映射已由测试核对。
- [x] 5B：tag、history、collect、notification 已完成实现、隔离验证、独立复审和计划记录（2026-11-17）；19 条实际路由映射已由测试核对。本轮到此暂停。
- [x] 5C：comment、draft、article 共 27 条路由已完成实现、隔离验证、独立复审和计划记录（2026-11-18）。
- [x] 5D：flow、flowDraft 共 6 条路由已完成实现、隔离验证、独立复审和计划记录（2026-11-18）。
- [x] 5E：avatar、image、media、video、ai 共 14 条路由已完成实现、隔离验证、独立复审和计划记录（2026-11-18）。16 组 85 条旧业务路由的完整映射已验收。

- [x] 每组先固定关键失败断言，再迁移输入/身份/响应；保留默认值、null/省略、数字/日期序列化和错误文案。
- [x] /flow/draft 不被 /flow/:id 吞掉，/article/random/toc、images、video 优先级正确；将正则 capture 改为命名参数并测非法 id。
- [x] 保持维护→认证→封禁/权限的现有顺序；不能改变原503/401判定或绕过所有权。候选头像删除的本人限制见 5E 记录。
- [x] Zod 错误适配业务响应，业务层必要校验保留，不能假定所有调用都经过 HTTP。
- [x] 每组运行对应 HTTP/controller/service 回归及 type-check；最终通过 source/dist 业务路由清单，Task 5 在 5E 完成后暂停。

验收：每个实际端点有迁移去向，核心成功/错误断言存在；对照只能归一化约定随机ID/时间戳，不能忽略字段类型、状态、业务code或headers。

### Task 6：流式落盘、媒体读取与视频任务

**Files:** `src/http/upload/{multipart,uploadedFile,tempFiles}.ts`；候选上传 middleware、媒体读取和视频操作边界；`test/http/{multipart,mediaRead,videoLifecycle}.test.ts`。

**Interfaces:** 上传输出显式区分磁盘/内存资源，适配 Service 原有字段，不伪造 Koa Context。

```ts
export interface DiskUpload {
  kind: 'disk';
  fieldname: string;
  originalname: string;
  filename: string;
  destination: string;
  path: string;
  mimetype: string;
  size: number;
}
export interface MemoryUpload {
  kind: 'memory';
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
```

- [x] 保留字段 avatar/img/video/image；同名多文件全部接收，不能被默认 parseBody 覆盖为最后一个。
- [x] 保留普通图片20张×20MiB、视频单文件20MiB、Flow单文件10MiB。总请求限制包括multipart开销，不能把单文件上限当批次上限。头像原规则先记录，新增限制若改变契约需明确报告。
- [x] 磁盘路径使用流式 multipart + pipeline，不整体 arrayBuffer。覆盖伪造Content-Length、分块传输、超量文件、字段/MIME错误、中断和磁盘失败；bodyLimit不能预读完整请求后再交给Node解析器。
- [x] 使用 Node 原始请求时按锁定版本的 `HttpBindings` 扩展 AppEnv；解析前不能有日志/校验中间件消费该请求体。真实 Node adapter 测试覆盖此路径，不用无原始 socket 的 app.request 假造测试成功。
- [x] 解析前完成适用的维护/认证。失败清理本请求临时文件并结束流，不删除已提交的媒体；文件名避免双实例同毫秒碰撞，保留扩展名和URL兼容。
- [x] 保留首张图片small缩略图、Flow像素验证、视频pending→processing→completed/failed、封面、R2晋升/本地回退。不能简化已有R2并发/删除事务保障。
- [x] 文件读取覆盖不存在、路径穿越、Content-Type、完整视频、Range206、非法Range416、HEAD、Content-Length/缓存头；不能用无鉴权通用静态目录替换全部读取业务。
- [x] 将后台FFmpeg promise加入可观测集合，退出等待或留下可恢复状态；测试HTTP断开后任务继续按原业务推进，以及退出不丢失在途任务。
- [x] 用可注入小阈值验证边界，单独用临时文件和受控流验证内存不会随整批大小线性增长，不在普通测试反复分配400MiB buffer。

验证：`pnpm test:hono`；有FFmpeg时 `pnpm test:video-media`。真实PG/R2集成按隔离条件单独执行并记录，不因上传mock通过就宣称整条媒体链通过。

### Task 7：Service / SQL / Storage / Utils 严格类型化

**Files:** `src/service/**/*.js`、`src/app/database.js`、`src/app/database/*.js`、storage/utils/constants、Result/BusinessError → TS；对应service/SQL测试。

**Interfaces:** 保留execute/getConnection/beginTransaction/commit/rollback/release及结果协议，明确SELECT行与DML变更结果；不改变SQL与事务归属。

- [x] 先迁纯常量、SQL builder、工具与数据库接口，再按依赖图迁业务；一个模块不长期保留js/ts两份实现。
- [x] 定义实际业务Row、JSONB、nullable列、safe int8、MutationResult和事务类型，保留问号占位符转换、RETURNING id、affectedRows行为；不能全库Record<string,any>。
- [x] 查询类型不能替代运行时校验；unknown异常收窄，JSONB/Tiptap/AI输入使用明确schema/解析函数。
- [x] 对需要mock的依赖增加factory/构造注入，真实默认实例在生产装配层创建；同步替换require.cache/Module._load。已有注入边界复用，不为形式重写全部class。
- [x] Utils的HTTP分页/error emission与纯文本/bcrypt工具分离，Service不导入HTTP app；保持分页转换和密码哈希兼容。
- [x] 每批跑对应service/SQL测试和type-check；禁止全局declare module、成片ts-ignore、关闭strict或双重断言代替修类型。

验收：Service/SQL/Storage不依赖Koa或Hono Context；PG兼容层、事务、媒体并发/清理和凭据脱敏断言保留。

### Task 8：Socket、采集、CLI与独立清理Worker

**Files:** `src/socket_server.ts`、`src/socket/**/*.ts`、`src/ingest/**/*.ts`、`src/tasks/*.ts`、`src/tasks/cleanup.worker.ts`、`src/app/keys/generate-keys.ts`；对应测试及scripts。

**Interfaces:** HTTP/Socket共用Token规则和通知payload；cleanup worker显式启动/可关闭；CLI参数、返回和退出码保持兼容。

- [x] 迁移Socket.IO、presence、Redis adapter和通知bus，保留user:<id>房间、notification:new事件；连接可关闭，不能让测试/退出挂起。
- [x] 验证Redis通知namespace隔离；测试发布不能影响正式namespace。生产候选明确与原Socket共享正式协议/通道。
- [x] 迁移ingest collectors/repositories/pipeline/worker/cli，保留INGEST_ENABLED只控制调度而不阻止显式CLI的语义。
- [x] cleanup.worker复用无import副作用的factory；关闭开关不创建任务。不要假定cron noOverlap能跨进程互斥；发布时明确唯一旧/新执行方。
- [x] 迁移CLI的require.main判断、测试中写死.js入口的子进程参数、fixture与迁移SQL路径；支持源码开发和编译产物两种方式。
- [x] 测试使用fake或隔离环境，不将真实采集发布、媒体迁移、生成密钥作为启动smoke。

验收：所有独立入口进入构建；现有Socket/ingest/媒体任务行为测试保留，任务实例可以正常关闭。

### Task 9：最终ESM收敛和兼容层清理

**Files:** package、tsconfig、src/main.ts、router/controller/middleware、tests、ecosystem.config.js→ecosystem.config.cjs、justfile、README、HONO_MIGRATION。

**Interfaces:** 生产只使用dist JS及运行时依赖；源码ESM；工具配置允许.cjs，不属于未迁移业务代码。

- [x] 所有调用方和测试已摆脱CJS缓存mock后，将Hono模块移回原职责目录，main.hono合并为main.ts；更新静态注册与测试import。
- [x] 根package设置type:module；统一相对.js import、import type、import.meta路径。PM2等配置改为.cjs并验证工具可加载。
- [x] 删除allowJs/checkJs、临时paths、jsconfig和module-alias；启用verbatimModuleSyntax:true；测试迁TS并用node --import=tsx --test执行。删除Koa对照app/HTTP实现。
- [x] dev=tsx watch src/main.ts，start=Node dist/main.js；start:socket/start:ingest/ingest/media:migrate/start:cleanup都指向对应实际入口。test纳入service/tasks/controller/http；DB/FFmpeg测试保持独立。
- [x] 清理dist后重建，防止删除的源文件残留旧产物。验证fresh release不带src时可运行，不靠源码目录兜底alias/资源缺失。
- [x] 搜索活跃代码Koa/module-alias/require.cache引用并移除不用依赖；历史文档可保留。回滚依赖旧release/commit，不在新实现永久携带第二套业务。

验证：`pnpm type-check`、`pnpm build`、`pnpm test`；`rg --files src -g '*.js'`应为空。字符串扫描只是辅助，不能代替运行验证。

### Task 10：部署材料与本地发布演练

**Files:** `deploy/ecosystem.hono.config.cjs`、`deploy/nginx.hono.example`、`deploy/README.md`、`.env.example`、README、justfile；`test/tasks/deployConfig.test.ts`。候选健康及退出接线涉及 `src/app/database/pg.factory.ts`、`src/hono.bootstrap.ts`、`src/http/registerRoutes.ts`、`test/http/lifecycle.test.ts`。

**Interfaces:** 配置只管理新HTTP，要求明确release cwd/env文件/port；加载配置对象不启动PM2。生产示例不能当已核验配置执行。

- [x] 新PM2命名如coderx_hono_candidate，直接Node运行dist/main.js，独立日志；host=127.0.0.1、BACKGROUND_JOBS_ENABLED=false。release/env/port缺失拒绝生成启动配置，不猜生产目录。
- [x] 使用wait_ready时，入口在监听及关键依赖就绪后process.send('ready')；设置listen_timeout/kill_timeout。本次关闭 wait_ready，以 HTTP 探测确认就绪。SIGINT/SIGTERM共用幂等关闭流程，kill_timeout大于应用排空期限；具体期限发布前按最长请求/任务核验。
- [x] Nginx示例保留正式域名/API路径、代理headers、Socket独立upstream；AI buffering/timeout和multipart限制明确。读取现有线上配置后才能合并，不能整份覆盖。
- [x] 文档列隔离测试/候选生产配置：PG、媒体根、R2、Redis及通知通道、JWT、前端origin、OAuth callback、AI、调度。受保护测试域名与前端预览连接测试API/Socket，正式前端不动。
- [x] 固定commit构建到新release，不在旧目录checkout/install；依赖各自独立。正式新旧共享明确路径的正式媒体，隔离测试使用自己的媒体。
- [x] 新deploy配方只操作候选实例，不复用现有整组pm2 restart；不执行deploy-first-time，不生成生产密钥。
- [x] 记录构建SHA/制品hash/配置引用/进程状态/实际流量状态，区分代码提交、部署、online与ready；用本地隔离资源演练启动、停止和恢复。

验收：配置引用的入口存在、可加载，部署手册可照着执行且所有实际环境参数来源明确；未执行远程写入或切流。

### Task 11：本地最终验收与交接

**Files:** 更新本计划记录、README、HONO_MIGRATION、deploy/README，并修复发现的缺口。

- [x] 完整测试、type-check、clean build；最低Node22.22.2与计划部署版本验证关键入口。缺少某版本则准确记录，不宣称已覆盖。
- [x] 全16模块契约、真实Node上传/流/取消/Range通过；763只是历史基线，不强求新套件同一数量，删除/合并用例需有替代断言。
- [x] 确认可丢弃PG库后运行事务、幂等、媒体并发/删除集成。migrations不是空库完整初始化脚本，先读migrations/README；缺测试Schema继续独立任务并记录，不能借开发库代替。
- [x] FFmpeg实测及R2/Redis/AI/OAuth集成分别标记mock、隔离实测、未验证，不能混称通过。
- [x] 验证不带src的release、任务开关、readiness失败、缺密钥/错误env和shutdown；不能误报就绪。
- [x] 检查无非预期DDL/API变更、凭据/媒体提交、类型逃逸、遗留业务JS和关键覆盖下降。
- [x] 更新勾选、真实命令/结果、当前分支、完成项、剩余项、待确认环境与候选构建。可按验证过的独立阶段做本地小提交，不push/合并/部署，不混入用户无关改动。

本地交付完成后给出可审查结果；外部集成缺条件时指出准确限制，不能把尚未执行Task12描述为已上线。

### Task 12：未来线上验证、切流及回滚（另行授权执行）

本节是runbook要求，不是下一会话自动执行的生产命令。先完成具体配置、本地验证和发布材料；需要实际操作目标环境时再确认目标、版本与窗口，不重复询问已批准的本地迁移。

**12A 隔离线上验证**

- [x] 读取核实服务器Node/PM2/Nginx、端口/目录/资源余量、当前commit、实际媒体/密钥路径，见 2026-11-20 Task 12A 目标机只读核查。
- [ ] 固定制品部署到新release，独立PG/媒体/R2/Redis/JWT，受保护测试入口；不要复制正式JWT和凭据充当测试配置。
- [ ] 测登录、文章/Flow、草稿、图片/视频、AI流、Socket通知、OAuth回调；外部副作用全部落在测试环境。
- [ ] 同机限制CPU/内存/并发/PG pool，大压测和批量转码放独立环境；不同端口不等于资源隔离。

**12B 生产候选与切流**

- [ ] 同一已验证制品启动生产候选，不把仍在使用的测试实例热改生产配置；独立端口/进程，正式PG/媒体/JWT/Redis协议兼容。
- [ ] 先维护者访问；测试账号写入也是正式写入。禁止把写请求镜像到新旧两边，GET也先确认副作用；不做失败后自动向另一版重试写操作。
- [ ] 新旧能读取彼此数据与媒体；本次不附带删列、枚举或JSONB不兼容变更。
- [ ] 候选HTTP不清理/采集，旧Socket/ingest继续运行；清理当前可能由旧Koa持有，切独立Worker前先停旧调度并等待在执行任务结束，再启动唯一的新执行方。
- [ ] 若旧release没有单独禁用清理的接口，就保持旧版为唯一执行方，等请求和任务排空并停止旧HTTP后再启新cleanup；不能假设流量切走会自动停止旧cron。
- [ ] 检查Nginx配置后平滑reload，正式API上游切新端口，Socket入口/正式域名保持。DNS不用于即时切换回滚。
- [ ] 旧Koa保留处理在途请求、上传、AI流和后台FFmpeg；reload不会迁移已有流，确认排空后才能停旧进程。
- [ ] 观察5xx/业务错误、P95、CPU/内存、PG pool、上传/视频完成率、AI首包/中断、通知，记录buildId；阈值依据旧版基线制定。

**12C 回滚与收尾**

- [ ] 异常时先将新流量切回旧上游并reload，再处理新进程在途请求/任务，恢复唯一后台任务归属。
- [ ] 切回代码不会撤销数据写入、删除和通知。数据问题单独修复，不自动恢复旧DB备份覆盖新的合法写入。
- [ ] 观察期保留旧release/依赖/配置引用；可停止进程但保留准确重启命令与媒体兼容路径，稳定后才清理临时资源。

## 4. 验收与测试执行规则

| 类别     | 最终标准                                                        |
| -------- | --------------------------------------------------------------- |
| Git      | 同仓库、历史保留、重命名可追踪、无凭据/生成媒体/无关文件混入    |
| TS       | 稳定TS7、strict通过、全部src运行时代码TS、临时CJS/JS桥移除      |
| HTTP     | 所有实际路由、外部契约、权限/错误/维护/限流兼容                 |
| 媒体与流 | 流式磁盘路线、数量/大小限制、取消清理、Range、UIMessage协议     |
| 业务数据 | PG事务/兼容层、R2生命周期、本地回退与新旧媒体可读性             |
| 多入口   | HTTP/Socket/ingest CLI及Worker/cleanup Worker/媒体CLI可构建验证 |
| 副作用   | factory/import不清理、不联网、不listen；候选HTTP默认无调度      |
| 发布     | 独立目录/端口/PM2、readiness、排空、切流回滚材料完整            |
| 证据     | 本地/隔离集成/生产分别记录，未执行不算通过                      |

每个任务先为真实变化补回归断言，确认失败原因，再做最小实现并跑定向测试；不写只复述实现结构的测试。已有断言优先复用。默认脚本尚未包含新TS测试时，用显式命令运行，不能漏测：

```bash
node --require ./test/support/runtime-guard.js --require ./test/support/isolated-runtime.js --test --test-concurrency=1 test/http/legacy.contract.test.js
node --require ./test/support/runtime-guard.js --import=tsx --test --test-concurrency=1 test/tasks/backgroundJobs.test.ts
node --require ./test/support/runtime-guard.cjs --import=tsx --test --test-concurrency=1 test/tasks/deployConfig.test.ts
```

以上示例于 2026-11-13 按 Task 2 隔离事故记录补上 guard；子进程同样必须显式预加载，不能仅依赖父测试进程。旧模块测试还需 isolated-runtime，运行时配置/启动测试只用显式临时 env/密钥。前两条为早期阶段命令示例。Task 10 的 deployConfig 验证现已纳入默认测试。这些命令在对应文件建好后执行；最终更新默认test涵盖这些范围。迁移中的测试文件名或脚本变化同步写回此计划，记录实际命令。阶段通过后继续下一项，只有新修改/失败/未解决风险才重复扩大测试。

## 5. 官方资料与版本复核

- [Hono Node](https://hono.dev/docs/getting-started/nodejs)、[最佳实践](https://hono.dev/docs/guides/best-practices)、[校验](https://hono.dev/docs/guides/validation)、[测试](https://hono.dev/docs/guides/testing)。
- [Hono v5迁移](https://hono.dev/docs/guides/migrating-to-v5)、[releases](https://github.com/honojs/hono/releases)：不混用预发布API。
- [TS7正式公告](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)、[标准包latest](https://registry.npmjs.org/typescript/latest)。
- [Node TS支持](https://nodejs.org/api/typescript.html)、[TS paths](https://www.typescriptlang.org/tsconfig/paths.html)：运行、类型检查和路径解析的区别。
- [busboy](https://github.com/mscdex/busboy)：流式multipart与资源限制。
- [PM2优雅启停](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/)、[cluster/reload](https://pm2.keymetrics.io/docs/usage/cluster-mode/)、[Nginx reload](https://nginx.org/en/docs/control.html)。

## 6. 下一会话可直接复制的提示词

```text
请执行本仓库的迁移计划：
/Users/yangdanping/Desktop/personal_project/coderx_server/docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md

先阅读计划、HONO_MIGRATION.md和适用的AGENTS.md，再检查Git状态与实际依赖。方向已确认：在当前仓库完成Koa/JS→Hono/TypeScript 7，保留Git历史与xxx.service.ts等命名，继续使用Node、PG及现有Socket.IO/媒体/AI能力。

从第一个未完成任务开始，按依赖顺序连续执行Task 0–11，完成本地代码、类型、测试、构建和可审查的部署材料；不要只重新给建议，也不要在常规阶段结束反复询问是否继续。保留当前计划与用户改动，复用合适checkout，在codex/前缀迁移分支工作。实现细节自行判断；需要调整计划时记录证据、原因和验证结果。

最终要完成业务源码TS/ESM收敛，不能只新增Hono空入口或用any永久包装原JS。新HTTP默认不运行清理/采集任务；重点保护接口/JWT兼容、磁盘上传、AI流、PG事务、媒体生命周期和现有测试覆盖。

本次只授权本地实施和部署准备，不push、不合并main、不部署或修改线上PM2/Nginx、不切流、不操作生产数据库/媒体/密钥。PG集成测试只在确认可丢弃的测试库运行；条件不足时继续其他独立任务并记录缺口。Task 12留待之后授权目标环境及发布操作。

每阶段更新计划勾选与真实验证结果。需要交接时，在文件中记录分支、完成/剩余项、失败或未执行检查及下一步；最终报告真实完成范围和发布条件，不把本地完成写成已经上线。
```
