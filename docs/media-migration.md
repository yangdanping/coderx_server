# Historical media migration operations

Phase 5 keeps every formal EC2 media file. Commands print JSON and never expose credential values.

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

Optional selectors are `--article-id`, `--after-file-id`, and `--limit`. `migrate-r2` additionally accepts `--concurrency` from 1 through 10; phase 5 uses 1 for the first batch and 3 thereafter.

Operational rules:

- Stop on any unexplained missing original, R2 conflict, nonzero migration failure, or reconciliation orphan.
- Record `nextAfterFileId` after every batch; resume with `--after-file-id`.
- Matching local/R2 identities are idempotent. Conflicting immutable identities are reported and never overwritten.
- `reconcile --repair` can only repair stale `pending` and invalid `ready` states. It does not delete R2 objects, local files, `file` rows, or articles.
- There is deliberately no `--delete-local` flag. Formal local cleanup belongs to phase 8 after observation and renewed user authorization.
