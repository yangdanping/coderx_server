# Ingest media synchronization

`backfill-raw` and `backfill-rich` persist article content and file IDs before media synchronization. The same ingest database adapter registers local `original` and `small` objects and invokes the shared published-image promotion service. Both local variants are required for a complete ingest publication. Existing immutable destination bytes must match the localized source; they are never overwritten.

Article persistence and media synchronization have separate outcomes:

- `created` / `updated` counts committed articles. `failed` counts extraction, copy or persistence failures before commit.
- `articles[].media.status = ready` means all required local variants were registered, R2 promotion completed, and retired media cleanup completed.
- `local_ready` means local variants are registered and R2 writes are disabled or paused. This does not claim R2 publication.
- `retry_required` means the article is committed, its local source files are retained, and the media result needs attention. Inspect `registration`, `promotion`, `cleanup` and `reason` for missing assets, conflicts, partial uploads, pending uploads or deferred deletion. Temporary-directory cleanup problems appear separately in `cleanupWarnings`.

Retry only media for persisted **article IDs**, without downloading sources, invoking enrichment or publishing/replacing an article:

```sh
NODE_ENV=production node src/ingest/cli.js retry-media --ids 150,151
```

Use 1–5 unique article IDs per invocation. Backfill commands continue to take **candidate IDs**. Check each returned status; CLI exit success by itself does not mean R2 publication completed. Ready-object retries verify existing objects with HEAD and do not duplicate file IDs or object identities. Failed reservations can be retried; a stale `pending` reservation needs the existing reconciliation procedure before it can be safely reclaimed. Missing local bytes or immutable-content conflicts need correction before retry can complete.

`MEDIA_WRITE_MODE=local` and `MEDIA_R2_WRITE_PAUSED=true` disable R2 uploads and R2 deletion while still registering local variants. Retired media with R2 registration remains tracked until writes resume. `MEDIA_MUTATIONS_PAUSED=true` blocks backfill mutations and makes media retry report `retry_required` without writes. R2 credentials and capacity limits come from the ingest runtime environment; no application database pool is used.

Replacement reuses unchanged filenames/content and file/media IDs. Changed or removed ingest files are detached transactionally rather than cascading their media registrations immediately. After commit, synchronization deletes their R2 objects through the shared deletion lifecycle, then deletes detached file rows and enqueues the existing local cleanup tombstones. Remote deletion or unlink failures retain retry state. Restoring an immutable filename cancels its stale tombstones inside the replacement transaction. Cleanup is restricted to this article's ingest candidate filename prefixes, excludes current owners, and holds the candidate advisory lock through the final reference check and unlink. CLI backfill and retry commands also share the existing ingest advisory lock across copying, persistence and synchronization; callers invoking lower-level pipeline/service APIs concurrently must provide equivalent operation serialization.

For an operational repair, scope article/file IDs explicitly and review the returned variant-level report. This command can complete previously retired media deletion; use the exact approved historical registration/upload manifest when the repair must preserve every existing object and file. This document does not authorize production deployment, reconciliation or cleanup.
