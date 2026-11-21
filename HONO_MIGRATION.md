# Hono migration

> Current decision: 2026-11-10 (Asia/Shanghai). The user has explicitly approved migration in this repository, with implementation in the next session. The historical deferral below is superseded; do not request the same architecture approval again.
>
> Active plan: [Koa → Hono / JavaScript → TypeScript 7](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md).
>
> Local acceptance finished on 2026-11-20 (Asia/Shanghai). The Hono and strict TypeScript ESM candidate passed the full regression suite and a source-free runtime check on Node 22.22.2 and 26.13.1. Target-environment verification and cutover are tracked in Task 12 and require separate authorization. [Local acceptance record](docs/superpowers/plans/2026-11-10-koa-to-hono-typescript-migration.md#2026-11-20-task-11-本地最终验收与交接) · [Release runbook](deploy/README.md)

## Approved scope

- Keep this repository and Git history; preserve names such as `article.service.ts`.
- Migrate to Hono and stable TypeScript 7 on Node.js, with a staged transition to ESM.
- Retain PostgreSQL, existing API/JWT contracts, Socket.IO, AI/media/ingest capabilities, and PM2.
- Prepare separate release directories and ports for old/new HTTP instances; let the reverse proxy switch traffic.
- The next implementation session may change local code, dependencies, tests, builds, and prepare reviewable deployment materials.
- Do not push, merge to main, deploy, change live PM2/Nginx, switch traffic, or operate on production data/media/keys without subsequent authorization for those actions.
- Database integration tests require an explicitly identified disposable database and isolated test media/credentials. Localhost alone does not prove a database is disposable.

## Superseded evaluation (historical record)

The remainder records the earlier decision and is not an instruction to defer the newly approved work.

> Last reviewed: 2026-10-25 (original decision: 2026-08-11)
>
> Status: not scheduled; do not implement without a new user decision
>
> Learning prototype: maintainer-local `learn_hono`, outside this repository and not required to run CoderX.

### Previous decision

CoderX Server continues to use Koa 3 and CommonJS. No Hono bootstrap, dependency installation, parallel HTTP process, route cutover, Nginx change, or production migration is part of the current repository maintenance work.

Hono remains only a possible future direction. The user will decide whether and when to start a separate migration project. Until that decision is explicit, new work follows the current Koa architecture and existing deployment model.

### What the prototype proved

The learning project demonstrates a possible Node.js baseline with:

- Hono and `@hono/node-server`
- ESM and strict TypeScript
- Zod and `@hono/zod-validator`
- route composition with `app.route()`

This is research evidence, not authorization to change `coderx_server`.

### Boundaries at the time

- HTTP API: Koa 3
- Database: PostgreSQL and the existing SQL/transaction adapter
- Media processing: Sharp, Jimp, FFmpeg, and local pending files
- Published media: existing Cloudflare R2/CDN `r2_on_publish` path
- Realtime and jobs: Socket.IO, PM2, node-cron, and current worker processes

Flow image upload therefore uses Koa and the production-proven R2 path. It does not wait for, bootstrap, or partially introduce Hono.

### Requirements recorded before approval

A future migration must start as a separate task with its own design approval. At minimum it must decide:

1. Node/EC2 versus another runtime.
2. Incremental route cutover versus a replacement release.
3. TypeScript/ESM boundaries around the current CommonJS services.
4. Compatibility requirements for responses, JWT, multipart, PostgreSQL transactions, media cleanup, and R2 fallback.
5. PM2, Nginx, tests, observation, and rollback strategy.

No item in this document should be treated as an active implementation step.
