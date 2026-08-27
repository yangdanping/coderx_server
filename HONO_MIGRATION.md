# Hono migration evaluation — deferred

> Last updated: 2026-08-11
>
> Status: not scheduled; do not implement without a new user decision
>
> Learning prototype: `/Users/yangdanping/Desktop/personal_project/learn/learn_hono`

## Current decision

CoderX Server continues to use Koa 3 and CommonJS. No Hono bootstrap, dependency installation, parallel HTTP process, route cutover, Nginx change, or production migration belongs to the current Flow work.

Hono remains only a possible future direction. The user will decide whether and when to start a separate migration project. Until that decision is explicit, new work follows the current Koa architecture and existing deployment model.

## What the prototype proves

The learning project demonstrates a possible Node.js baseline with:

- Hono and `@hono/node-server`
- ESM and strict TypeScript
- Zod and `@hono/zod-validator`
- route composition with `app.route()`

This is research evidence, not authorization to change `coderx_server`.

## Boundaries that remain stable now

- HTTP API: Koa 3
- Database: PostgreSQL and the existing SQL/transaction adapter
- Media processing: Sharp, Jimp, FFmpeg, and local pending files
- Published media: existing Cloudflare R2/CDN `r2_on_publish` path
- Realtime and jobs: Socket.IO, PM2, node-cron, and current worker processes

Flow image upload therefore uses Koa and the production-proven R2 path. It does not wait for, bootstrap, or partially introduce Hono.

## If migration is approved later

A future migration must start as a separate task with its own design approval. At minimum it must decide:

1. Node/EC2 versus another runtime.
2. Incremental route cutover versus a replacement release.
3. TypeScript/ESM boundaries around the current CommonJS services.
4. Compatibility requirements for responses, JWT, multipart, PostgreSQL transactions, media cleanup, and R2 fallback.
5. PM2, Nginx, tests, observation, and rollback strategy.

No item in this document should be treated as an active implementation step.
