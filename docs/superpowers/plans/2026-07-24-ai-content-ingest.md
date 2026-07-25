# AI Content Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Koa-independent Node.js worker that stages public AI RSS/Atom entries, optionally enriches them in Chinese, and safely publishes approved candidates into CoderX.

**Architecture:** A standalone `src/ingest` package owns source collection, normalization, scoring, enrichment, persistence, approval, and publication. PM2 keeps one scheduling process alive, node-cron triggers runs, and a PostgreSQL advisory lock plus unique constraints make collection and publication idempotent.

**Tech Stack:** Node.js CommonJS, node:test, PostgreSQL 18, `pg`, `node-cron`, `xml2js`, `happy-dom`, AI SDK/OpenAI-compatible Ollama, PM2.

## Global Constraints

- Do not import Koa, routers, controllers, or request contexts from `src/ingest`.
- Default `INGEST_ENABLED=false` and `INGEST_AUTO_PUBLISH=false`.
- First-party/public feeds only; no login automation and no third-party full-text copying.
- Every external request has a timeout and explicit User-Agent.
- PostgreSQL uses snake_case, `BIGINT GENERATED ALWAYS AS IDENTITY`, `TIMESTAMPTZ`, explicit checks/FKs, and indexes on FK/access paths.
- Candidate ingestion is idempotent by canonical URL, source external ID, and content hash.
- Formal article publication requires an existing author name and tag name and runs in one transaction.
- Production deployment and production database mutation are out of scope for this execution.

---

### Task 1: PostgreSQL ingest schema

**Files:**
- Create: `migrations/008_create_content_ingest_pipeline.sql`
- Modify: `migrations/README.md`
- Create: `test/tasks/contentIngest.migration.test.js`

**Interfaces:**
- Produces tables `ingest_source`, `ingest_run`, `ingest_candidate`, and `article_source`.
- Produces unique constraints used by `ON CONFLICT (source_key)` and `ON CONFLICT (canonical_url)`.

- [ ] **Step 1: Write the failing migration contract test**

```js
test('content ingest migration defines durable sources, runs, candidates and article attribution', () => {
  assert.match(sql, /CREATE TABLE ingest_source/i);
  assert.match(sql, /CREATE TABLE ingest_run/i);
  assert.match(sql, /CREATE TABLE ingest_candidate/i);
  assert.match(sql, /CREATE TABLE article_source/i);
  assert.match(sql, /canonical_url TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /source_published_at TIMESTAMPTZ/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because migration 008 is missing**

Run: `node --test test/tasks/contentIngest.migration.test.js`

Expected: FAIL with `ENOENT` for `008_create_content_ingest_pipeline.sql`.

- [ ] **Step 3: Add transactional DDL with checks, FKs, partial unique indexes and access-path indexes**

Implement the four tables from the approved design. Use text checks for evolving statuses, JSONB object checks, FK indexes, `(status, score DESC, source_published_at DESC)` for candidate review, and partial unique indexes for non-null `external_id` and `content_hash`.

- [ ] **Step 4: Run the focused test and migration syntax check**

Run:

```bash
node --test test/tasks/contentIngest.migration.test.js
PGPASSWORD=123456 psql -h 127.0.0.1 -p 5432 -U postgres -d coderx -v ON_ERROR_STOP=1 -f migrations/008_create_content_ingest_pipeline.sql
```

Expected: test PASS and migration COMMIT.

- [ ] **Step 5: Commit**

```bash
git add migrations/008_create_content_ingest_pipeline.sql migrations/README.md test/tasks/contentIngest.migration.test.js
git commit -m "feat(ingest): add PostgreSQL staging schema"
```

### Task 2: Feed sources, parsing, URL normalization and scoring

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/ingest/config/sources.js`
- Create: `src/ingest/domain/normalizeUrl.js`
- Create: `src/ingest/domain/scoreCandidate.js`
- Create: `src/ingest/collectors/rssCollector.js`
- Create: `test/tasks/contentIngest.domain.test.js`
- Create: `test/fixtures/ingest/rss.xml`
- Create: `test/fixtures/ingest/atom.xml`

**Interfaces:**
- Produces `normalizeCanonicalUrl(rawUrl): string`.
- Produces `scoreCandidate(candidate, source, now): number`.
- Produces `parseFeed(xml, source): FeedEntry[]`.
- Produces `collectFeed(source, { fetchImpl, timeoutMs }): Promise<FeedEntry[]>`.

- [ ] **Step 1: Write failing domain tests**

```js
test('normalizeCanonicalUrl removes tracking and fragments while preserving content params', () => {
  assert.equal(
    normalizeCanonicalUrl('https://example.com/post/?utm_source=x&id=7#top'),
    'https://example.com/post?id=7',
  );
});

test('parseFeed maps RSS and Atom into one stable entry shape', () => {
  assert.deepEqual(parseFeed(rss, source)[0], {
    externalId: 'post-1',
    url: 'https://example.com/post-1',
    title: 'AI release',
    summary: 'Release summary',
    publishedAt: '2026-07-24T01:00:00.000Z',
    author: 'Example',
    raw: assert.anything(),
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/tasks/contentIngest.domain.test.js`

Expected: FAIL because `src/ingest/domain/normalizeUrl.js` does not exist.

- [ ] **Step 3: Reuse the cached XML/HTML parsers and implement minimal pure functions**

Run: `pnpm add --offline xml2js@0.5.0`

Implement RSS 2.0 and Atom parsing with `xml2js`, HTML-to-text cleanup with the existing `happy-dom` dependency, deterministic URL normalization, recency/keyword/source scoring, and an immutable source catalog containing only public feeds.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/tasks/contentIngest.domain.test.js`

Expected: all domain tests PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingest test/tasks/contentIngest.domain.test.js test/fixtures/ingest
git commit -m "feat(ingest): collect and normalize public feeds"
```

### Task 3: Candidate repository and collection runner

**Files:**
- Create: `src/ingest/repositories/ingestRepository.js`
- Create: `src/ingest/pipeline/collectCandidates.js`
- Create: `src/ingest/pipeline/runWithLock.js`
- Create: `test/tasks/contentIngest.repository.test.js`
- Create: `test/tasks/contentIngest.pipeline.test.js`

**Interfaces:**
- Produces `createIngestRepository(database)`.
- Produces repository methods `syncSources`, `createRun`, `finishRun`, `upsertCandidates`, `listCandidates`, and `withAdvisoryLock`.
- Produces `collectCandidates({ sources, collector, repository, days, limit, now })`.

- [ ] **Step 1: Write failing repository and pipeline tests**

Test that source upserts use `ON CONFLICT (source_key)`, candidate upserts use `ON CONFLICT (canonical_url) DO UPDATE`, failed sources do not prevent successful sources from persisting, and a false advisory lock result returns `{ skipped: true }`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/tasks/contentIngest.repository.test.js
node --test test/tasks/contentIngest.pipeline.test.js
```

Expected: FAIL because repository and pipeline modules are missing.

- [ ] **Step 3: Implement repository with dependency injection**

Use the existing `src/app/database` adapter only at composition time. Keep SQL inside the repository module, use the same acquired connection for session advisory lock/unlock, and release it in `finally`.

- [ ] **Step 4: Implement source-isolated collection**

For each enabled source, catch and record errors independently. Filter invalid URLs, cutoff dates and zero-score items before applying the global limit. Return exact run statistics.

- [ ] **Step 5: Verify GREEN and commit**

Run: `node --test test/tasks/contentIngest.repository.test.js test/tasks/contentIngest.pipeline.test.js`

```bash
git add src/ingest/repositories src/ingest/pipeline test/tasks/contentIngest.repository.test.js test/tasks/contentIngest.pipeline.test.js
git commit -m "feat(ingest): stage idempotent feed candidates"
```

### Task 4: Optional Chinese enrichment and Tiptap content

**Files:**
- Create: `src/ingest/enrichment/createOllamaEnricher.js`
- Create: `src/ingest/domain/buildArticleContent.js`
- Create: `src/ingest/pipeline/enrichCandidates.js`
- Create: `test/tasks/contentIngest.enrichment.test.js`
- Create: `test/tasks/contentIngest.content.test.js`

**Interfaces:**
- Produces `createOllamaEnricher({ generateTextImpl, model, baseURL })`.
- Produces `buildArticleContent(candidate): TiptapDoc`.
- Produces `enrichCandidates({ repository, enricher, limit })`.

- [ ] **Step 1: Write failing tests**

Test structured AI output normalization, title truncation to 50 characters, link marks in generated Tiptap JSON, and retention of pending status when enrichment fails.

- [ ] **Step 2: Verify RED**

Run: `node --test test/tasks/contentIngest.enrichment.test.js test/tasks/contentIngest.content.test.js`

Expected: FAIL because enrichment modules are missing.

- [ ] **Step 3: Implement independent AI adapter**

Use `createOpenAI`, `generateText`, `Output.object`, and a Zod schema without importing `ai.service.js` or any HTTP framework. Read only explicit ingest environment values at composition time.

- [ ] **Step 4: Implement content builder and enrichment pipeline**

Build paragraphs/headings/link marks using plain JSON. Mark rows enriched only after validated Chinese fields and content JSON are persisted.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/tasks/contentIngest.enrichment.test.js test/tasks/contentIngest.content.test.js
git add src/ingest/enrichment src/ingest/domain/buildArticleContent.js src/ingest/pipeline/enrichCandidates.js test/tasks/contentIngest.enrichment.test.js test/tasks/contentIngest.content.test.js
git commit -m "feat(ingest): enrich candidates for CoderX"
```

### Task 5: Approval, transactional publication and CLI

**Files:**
- Modify: `src/ingest/repositories/ingestRepository.js`
- Create: `src/ingest/pipeline/publishCandidates.js`
- Create: `src/ingest/cli.js`
- Create: `src/ingest/config/runtime.js`
- Modify: `package.json`
- Create: `test/tasks/contentIngest.publish.test.js`
- Create: `test/tasks/contentIngest.cli.test.js`

**Interfaces:**
- Produces repository methods `approveCandidates` and `publishApproved`.
- Produces `publishCandidates({ repository, authorName, tagName, limit })`.
- CLI commands: `collect`, `enrich`, `list`, `approve`, `publish`, `run`.

- [ ] **Step 1: Write failing publish tests**

Test that missing author/tag rolls back, only approved rows are locked, standard article/tag/source rows are written in order, duplicate publication is harmless, and candidate status changes only before commit.

- [ ] **Step 2: Verify RED**

Run: `node --test test/tasks/contentIngest.publish.test.js test/tasks/contentIngest.cli.test.js`

Expected: FAIL because publish and CLI modules are missing.

- [ ] **Step 3: Implement publication transaction**

Resolve author and tag by names, lock candidates with `FOR UPDATE SKIP LOCKED`, insert article using `RETURNING id`, insert article tag and source attribution, then mark candidate published. Roll back the entire batch on error.

- [ ] **Step 4: Implement safe CLI**

Parse only known commands/options, render list output without secrets, require explicit `approve`, and never let `run` publish unless `INGEST_AUTO_PUBLISH=true`.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/tasks/contentIngest.publish.test.js test/tasks/contentIngest.cli.test.js
git add src/ingest package.json test/tasks/contentIngest.publish.test.js test/tasks/contentIngest.cli.test.js
git commit -m "feat(ingest): approve and publish staged content"
```

### Task 6: Scheduler, PM2 process and operator documentation

**Files:**
- Create: `src/ingest/worker.js`
- Modify: `ecosystem.config.js`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `test/tasks/contentIngest.worker.test.js`

**Interfaces:**
- Produces `startWorker({ cron, run, config, logger })`.
- Adds PM2 application `coderx_ingest_worker`.

- [ ] **Step 1: Write failing worker test**

Test timezone, `noOverlap`, disabled-run skip behavior and safe rejection logging.

- [ ] **Step 2: Verify RED**

Run: `node --test test/tasks/contentIngest.worker.test.js`

Expected: FAIL because worker module is missing.

- [ ] **Step 3: Implement worker and deployment-safe defaults**

The scheduler stays alive when disabled, but its callback exits before database/network work. Add PM2 process with one fork instance and separate logs.

- [ ] **Step 4: Document commands and rollout gates**

Document local migration, collect/enrich/list/approve/publish commands, environment values, advisory-lock behavior, shadow mode, and production stop point.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test test/tasks/contentIngest.worker.test.js
git add src/ingest/worker.js ecosystem.config.js .env.example README.md test/tasks/contentIngest.worker.test.js
git commit -m "feat(ingest): run scheduler as isolated PM2 worker"
```

### Task 7: Local database and first batch

**Files:**
- Create locally (ignored): `data/ingest-batches/2026-07-24-ai-backfill.json`

**Interfaces:**
- Uses CLI only; does not add production code.
- Produces a local candidate batch and verification report.

- [ ] **Step 1: Apply migration and inspect schema**

Run:

```bash
PGPASSWORD=123456 psql -h 127.0.0.1 -p 5432 -U postgres -d coderx -v ON_ERROR_STOP=1 -f migrations/008_create_content_ingest_pipeline.sql
PGPASSWORD=123456 psql -h 127.0.0.1 -p 5432 -U postgres -d coderx -c '\d+ ingest_candidate'
```

- [ ] **Step 2: Collect the local backfill**

Run: `pnpm ingest collect --days 30 --limit 100`

Expected: at least one successful source and candidates inserted only into `ingest_candidate`.

- [ ] **Step 3: Enrich when local Ollama is available**

Run: `pnpm ingest enrich --limit 60`

If health/model configuration is unavailable, retain pending candidates and report the concrete blocker without publishing fallback content.

- [ ] **Step 4: Export and inspect top 60**

Run: `pnpm ingest list --status enriched,pending --limit 60 --json > data/ingest-batches/2026-07-24-ai-backfill.json`

Verify source distribution, duplicate count, date range, missing titles/URLs and enrichment status using SQL/CLI summaries.

- [ ] **Step 5: Run final verification**

Run:

```bash
pnpm test
pnpm prettier --check .
git diff --check
git status --short
```

Expected: all tests pass, formatting check passes, no whitespace errors, and only the ignored local batch remains outside Git.

- [ ] **Step 6: Stop before production**

Do not push, SSH to production, apply production migration, restart PM2 remotely, approve, or publish candidates. Report the branch, commits, local database counts, source failures and exact next production command sequence.
