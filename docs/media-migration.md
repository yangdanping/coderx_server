# 存量媒体迁移 CLI

更新：2026-10-25。本文描述现有 CLI 的操作边界，不代表当前有迁移待执行；早期 Phase 5 是设计阶段名称。命令与参数已对照 `src/tasks/mediaMigration.cli.js` 核对。新采集文章的媒体失败重试见[采集说明](../CONTENT_INGEST.md)。

These migration commands preserve formal local media files and print JSON results.

Run from the deployed backend root with `NODE_ENV=production`. Inventory and reconciliation are read-only by default; local backfill and R2 migration also default to dry-run and require `--apply` to write.

```bash
NODE_ENV=production pnpm --silent media:migrate -- inventory --limit 1000
NODE_ENV=production pnpm --silent media:migrate -- backfill-local --dry-run --limit 1000
NODE_ENV=production pnpm --silent media:migrate -- backfill-local --apply --limit 1000
NODE_ENV=production pnpm --silent media:migrate -- migrate-r2 --dry-run --after-file-id 0 --limit 5 --concurrency 1
NODE_ENV=production pnpm --silent media:migrate -- migrate-r2 --apply --after-file-id 0 --limit 5 --concurrency 1
NODE_ENV=production pnpm --silent media:migrate -- reconcile
NODE_ENV=production pnpm --silent media:migrate -- reconcile --repair --pending-older-than-minutes 30
```

Optional selectors are `--article-id`, `--after-file-id`, and `--limit`. `migrate-r2` additionally accepts `--concurrency` from 1 through 10; choose concurrency for the target environment; the original rollout used 1 for the first batch and 3 thereafter.

Operational rules:

- Stop on any unexplained missing original, R2 conflict, nonzero migration failure, or reconciliation orphan.
- Record `nextAfterFileId` after every batch; resume with `--after-file-id`.
- Matching local/R2 identities are idempotent. Conflicting immutable identities are reported and never overwritten.
- `reconcile --repair` can only repair stale `pending` and invalid `ready` states. It does not delete R2 objects, local files, `file` rows, or articles.
- There is deliberately no `--delete-local` flag. This CLI does not delete formal local files. Local cleanup must be planned separately after checking the active storage modes and retention requirements.
