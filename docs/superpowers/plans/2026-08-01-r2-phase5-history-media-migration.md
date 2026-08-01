# R2 Phase 5 Historical Media Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely inventory, register, migrate, and reconcile all eligible published historical article media from EC2 local storage to Cloudflare R2 while retaining every formal local copy.

**Architecture:** A shared catalog service discovers immutable media variants from PostgreSQL and the service-owned `public/img` / `public/video` roots. Separate services perform read-only inventory, idempotent local-object backfill, bounded-concurrency R2 promotion, and DB/R2/local reconciliation; a single JSON CLI exposes dry-run and apply modes. Existing promotion primitives remain responsible for hashing, capacity reservation, conditional upload, HEAD verification, and immutable conflict handling.

**Tech Stack:** Node.js 24, Koa service modules, PostgreSQL 17, `pg`, AWS SDK v3 S3 client, Cloudflare R2 Standard, Node test runner, pnpm.

## Global Constraints

- Only published media (`file.article_id IS NOT NULL`) is eligible; drafts, orphans, avatars, incomplete videos, and FFmpeg intermediates are excluded.
- Never delete, move, truncate, or overwrite any formal local media in phase 5.
- Default migration settings are `scope=published`, `concurrency=3`, `deleteLocal=false`, `readMode=r2_preferred`.
- Every mutating command must have a read-only dry-run and print machine-readable counts, bytes, skips, and failures.
- Commands must support `--article-id`, `--after-file-id`, `--limit`, and migration `--concurrency`; positive safe integers only.
- R2 writes continue to honor `MEDIA_R2_WRITE_PAUSED` and `MEDIA_WRITE_MODE` and use the existing 7,000,000,000-byte hard guard.
- Existing R2 keys are immutable: matching size/SHA is idempotent; any conflict is reported and never overwritten.
- Missing local files are reported and never replaced with empty objects.
- Local media remains readable throughout migration; no phase 6 pause or phase 8 deletion is permitted.
- Do not read, print, copy, or commit production secrets. Do not touch the frontend repository's eight existing changes.

---

### Task 1: Shared Historical Media Catalog and Inventory

**Files:**
- Create: `src/tasks/mediaCatalog.js`
- Create: `src/tasks/inventoryMedia.js`
- Create: `test/tasks/mediaInventory.test.js`

**Interfaces:**
- `createMediaCatalog({ database, imageRoot, videoRoot, filesystem })`
- `catalog.listPublishedFiles({ articleId, afterFileId, limit }) -> Promise<FileRow[]>`
- `catalog.discoverVariants(fileRows) -> Promise<{ candidates, missingAssets, invalidRows }>`
- `inventoryMedia({ catalog, database, articleId, afterFileId, limit }) -> Promise<InventoryReport>`
- Each candidate contains `{ articleId, fileId, fileType, variant, localPath, filename, contentType, sizeBytes }` and never contains file bytes.

- [ ] Write failing tests proving deterministic file-id ordering, exact original/small and video/poster discovery, missing-variant reporting, non-regular-file rejection, physical-file-without-DB reporting, and structured image/video nodes without stable IDs.
- [ ] Run `node --test test/tasks/mediaInventory.test.js`; verify failures are caused by missing catalog/inventory modules.
- [ ] Implement parameterized PostgreSQL selection and safe basename/root containment validation. Traverse structured content without mutating it and summarize only article/node identity, not article text.
- [ ] Run the targeted test until green and run `git diff --check`.

### Task 2: Idempotent Local `media_object` Backfill

**Files:**
- Create: `src/tasks/backfillLocalMediaObjects.js`
- Create: `test/tasks/mediaLocalBackfill.test.js`

**Interfaces:**
- `backfillLocalMediaObjects({ catalog, database, articleId, afterFileId, limit, dryRun }) -> Promise<BackfillReport>`
- Local rows use canonical absolute paths, actual byte size, full lowercase SHA-256, provider `local`, status `ready`, and the catalog variant.

- [ ] Write failing tests for dry-run zero writes, successful insert, exact-row idempotency, conflicting existing-row refusal, missing-file skip, transaction rollback, and published-only filtering.
- [ ] Run `node --test test/tasks/mediaLocalBackfill.test.js`; verify expected RED failures.
- [ ] Implement streaming SHA-256 inspection and per-row `INSERT ... ON CONFLICT DO NOTHING`, followed by exact identity comparison inside a transaction. Never update a conflicting row.
- [ ] Run the targeted tests until green and run `git diff --check`.

### Task 3: Bounded Historical R2 Migration

**Files:**
- Create: `src/tasks/migrateMediaToR2.js`
- Create: `test/tasks/mediaMigration.test.js`

**Interfaces:**
- `migrateMediaToR2({ catalog, mediaPromotionService, articleId, afterFileId, limit, concurrency, dryRun, writeMode, writePaused }) -> Promise<MigrationReport>`
- Report fields include `examinedFiles`, `candidateObjects`, `candidateBytes`, `attempted`, `ready`, `idempotent`, `inProgress`, `failed`, `retainedLocal`, `nextAfterFileId`, and bounded failure descriptors.

- [ ] Write failing tests for dry-run, default/maximum bounded concurrency, article/after/limit forwarding, paused/local modes, missing files, matching ready objects, stale/conflicting results, partial failure continuation, and local-file retention.
- [ ] Run `node --test test/tasks/mediaMigration.test.js`; verify expected RED failures.
- [ ] Implement a small promise-pool with validated concurrency and delegate each candidate to the existing `mediaPromotionService.promote`. Do not add any local deletion option.
- [ ] Run targeted tests until green and run `git diff --check`.

### Task 4: DB/R2/Local Reconciliation and Stale-Pending Repair

**Files:**
- Modify: `src/storage/r2MediaStore.js`
- Modify: `src/service/mediaObject.service.js`
- Create: `src/tasks/reconcileR2Media.js`
- Create: `test/tasks/mediaReconciliation.test.js`
- Modify: `test/service/r2MediaStore.test.js`
- Modify: `test/service/mediaObject.service.test.js`

**Interfaces:**
- `r2Store.list({ continuationToken, prefix, maxKeys }) -> Promise<{ objects, continuationToken }>`
- `mediaObjectService.listR2Objects(...)`, `markStalePendingFailed(...)`, and existing guarded transition methods.
- `reconcileR2Media({ catalog, database, mediaObjectService, r2Store, repair, pendingOlderThanMs }) -> Promise<ReconciliationReport>`

- [ ] Write failing tests for paginated ListObjectsV2, ready Head match/missing/mismatch, matching stale pending promoted to ready, missing stale pending demoted to failed for retry, non-stale pending preserved, R2 objects without DB rows reported only, DB rows without logical files reported, local hash mismatch, and no deletion calls.
- [ ] Run targeted tests and verify expected RED failures.
- [ ] Implement pagination and guarded state repairs. `repair=false` is strictly read-only; `repair=true` may only change `pending/ready` state and must never delete R2/local objects or business rows.
- [ ] Run targeted tests until green and run `git diff --check`.

### Task 5: Safe Operational CLI

**Files:**
- Create: `src/tasks/mediaMigration.cli.js`
- Create: `test/tasks/mediaMigration.cli.test.js`
- Modify: `package.json`
- Modify: `migrations/README.md` only if operational command documentation belongs there; otherwise create `docs/media-migration.md`.

**Interfaces:**
- Commands: `inventory`, `backfill-local`, `migrate-r2`, `reconcile`.
- Flags: `--dry-run`, `--apply`, `--repair`, `--article-id`, `--after-file-id`, `--limit`, `--concurrency`, `--pending-older-than-minutes`.
- `backfill-local` and `migrate-r2` default to dry-run and require `--apply` to write; `reconcile` defaults read-only and requires `--repair` for guarded state repair.

- [ ] Write failing parser/action tests for every allowed flag, unknown/mutually-exclusive flags, defaults, maximum concurrency, JSON output, unavailable credentials on an R2 action, and guaranteed database shutdown.
- [ ] Run `node --test test/tasks/mediaMigration.cli.test.js`; verify expected RED failures.
- [ ] Implement dependency construction without displaying environment values, JSON-only stdout, nonzero exit on command-level failure, and per-item failures retained in the report.
- [ ] Add `pnpm media:migrate -- <command>` and concise operator documentation with exact dry-run/apply examples.
- [ ] Run all phase-5 task tests, `pnpm test`, `pnpm test:media-db`, and `git diff --check`.

### Task 6: Review, Production Backup, Deployment, and Online Migration

**Files:**
- Update after verified production results: `/Users/yangdanping/Downloads/coderx-R2-Cloudflare-CDN-分阶段实施-handoff.md`

- [ ] Review the complete diff against phase-5 requirements; resolve every Critical/Important issue.
- [ ] Commit and push the verified feature branch, then fast-forward `main` only after review/test evidence is current.
- [ ] Before production mutation, create and verify a PostgreSQL custom-format dump, media archive/SHA manifest, and mode-600 environment backup without outputting secrets.
- [ ] Deploy exact tested HEAD; keep all four production media switches unchanged and confirm three PM2 processes online.
- [ ] Run production `inventory`, `backfill-local --dry-run`, `migrate-r2 --dry-run`, and read-only `reconcile`; compare their expected objects/bytes and stop on any unexplained discrepancy.
- [ ] Apply local backfill, then migrate one article or the smallest bounded batch with `concurrency=1`; reconcile DB/R2/local, request CDN objects, and confirm public API behavior before continuing.
- [ ] Continue with small batches using `concurrency=3`, recording every batch cursor, object count, bytes, ready/idempotent/failure totals. Never delete local media.
- [ ] Run final read-only reconciliation, exact R2 List/Head totals, DB totals, EC2 existence/hash sampling, public API/CDN sampling, and video Range sampling when an eligible historical video exists.
- [ ] Run the complete test suites again, confirm backend/production HEAD and frontend eight-change preservation, then update the handoff with actual commit, tests, backup, batch totals, bytes, failures, CDN evidence, risks, and rollback state.

## Plan Self-Review

- Spec coverage: every phase-5 checklist item, required CLI flag, idempotency rule, batch report, and no-delete boundary maps to a task above.
- Placeholder scan: no TBD/TODO/“implement later” placeholders remain.
- Type consistency: catalog candidates are the shared input to backfill/migration/reconciliation; all reports use numeric counts/bytes and bounded failure descriptors.
- Scope: phase 6 pause/delta cutover, phase 7 monitoring automation, and phase 8 local deletion remain explicitly excluded.
