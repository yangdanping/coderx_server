# Ingest Media Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the application task; the parent performs the dependent production operations.

**Goal:** 修复导入媒体链路并补齐 12 个已发布文件的 24 个变体。

**Architecture:** 两个回填入口复用既有媒体能力，同步结果与数据库提交状态分离。保留文件身份和本地回退，使用既有幂等上传重试。

**Tech Stack:** Node.js CommonJS、node:test、PostgreSQL、现有 R2 SDK/服务；不增加依赖。

## Global Constraints

- Base: 16bbba5e2366582a54b3b12a6bf5725d83386e4f. Work only in this isolated worktree.
- Do not modify original checkout changes, PG version, cloud infrastructure, dependencies, credentials or unrelated features.
- Do not perform production operations from the implementation agent. Parent owns deployment/backups/repair.
- Production repair may only add the 24 missing local rows and upload/register the 24 missing R2 variants. Preserve existing local files and R2 objects.
- Implemented future retries must preserve file IDs for unchanged assets and never delete committed local files on post-commit failure.

## Task 1: Fix and verify ingest media lifecycle

**Files:** `src/ingest/pipeline/backfillRawArticles.js`, `backfillRichArticles.js`, `src/ingest/repositories/richArticleRepository.js`, `src/ingest/cli.js`; add a focused ingest media service if needed. Relevant reuse: `src/tasks/backfillLocalMediaObjects.js` (`registerCandidate`), `src/tasks/mediaCatalog.js`, `src/service/publishedImagePromotion.service.js`, `mediaPromotion.service.js`, `mediaObject.service.js`, `mediaDeletion.service.js`, `localMediaCleanup.service.js`. Tests in `test/tasks/contentIngest.*.test.js`; real-PG tests in `test/integration/` where useful. Add a short standalone ingest-media operations document, not unrelated README edits.

**Interfaces:** Keep existing entrypoint arguments, add an injected media synchronization dependency to raw/rich pipelines and construct its real implementation in CLI using the same ingest database. Return explicit per-article media result/retry status. No silent successful R2 publication on failed or incomplete uploads.

- [ ] Read the existing services and transaction/cleanup boundaries, then write a failing regression test. Example assertion after an injected synchronization failure: `assert.equal(result.created, 1); assert.deepEqual(removedCommittedPaths, []); assert.equal(result.articles[0].media.status, 'retry_required')` (field spelling may follow existing project conventions).
- [ ] Run focused node:test cases and retain expected RED output.
- [ ] Implement registration plus shared promotion after successful article persistence. Runtime registration must use the same database as ingest; no global app database leaks. Honor media write flags. Retry API must synchronize already persisted IDs without rerendering/republishing.
- [ ] Fix repository replacement identity and cleanup handling: unchanged filename/content keeps IDs and media rows; changed/removed registered media must not become R2 orphans. Retain recoverability and use existing lifecycle capabilities. If an architectural choice is unresolved, report a concrete proposal to the parent before implementing it.
- [ ] Verify raw creation, raw/rich replacement, committed upload failure, precommit rollback, paused/local mode, repeated retry, and partial upload recovery. Include meaningful real filesystem tests and real PostgreSQL integration where mock SQL cannot prove constraints/identity. Never use production DB or R2.
- [ ] Run focused suites GREEN, then complete baseline unit/service/controller/task suite once. Commands: `node --test --test-concurrency=1 'test/service/*.test.js' 'test/tasks/*.test.js' 'test/controller/*.test.js'`; follow `test/integration` harness for isolated tests. Preserve output files.
- [ ] Self-review and commit application fix/tests/docs only; report exact commands, RED/GREEN evidence, commits and any limits. No pushes or production changes.

## Task 2: Production completion (parent-owned)

- [ ] Refresh current consistent backup before production mutation; retain successful 20261012T065646Z rehearsal and validate new dump/media.
- [ ] Review Task 1 and resolve findings, validate deployment patch against unchanged production sources.
- [ ] Build exact 24-variant manifest using current read-only inventory, local bytes and intended R2 keys; inspect dry-run and refuse scope drift.
- [ ] Deploy reviewed code with rollback source snapshot; use controlled maintenance if needed and ensure restoration on all exits.
- [ ] Register and upload only manifest entries through shared services; verify every R2 object, run a second pass proving idempotency.
- [ ] Full read-only reconciliation, API/media health, unchanged production file hashes; refresh two-copy backup and docs. Pause before PG upgrade.
