# Raw Article Ingest and Placeholder Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import editable source-language articles with local images and remove the fixed-format placeholder articles from the local database.

**Architecture:** Keep the existing SSRF-safe page extractor, author/date assignment, per-article replacement transaction, and local asset promotion. Add a raw Tiptap builder and raw backfill pipeline that bypass Ollama, upgrade image decoding to Sharp, and add an exact structural cleanup command with an explicit apply flag.

**Tech Stack:** Node.js CommonJS, PostgreSQL, Tiptap JSON, Sharp, node:test, pnpm.

## Global Constraints

- The raw ingest path must not call Ollama or any translation model.
- Source scripts, styles, navigation, and cookie UI must not enter stored content.
- Images must be stored locally as JPEG plus a 320-pixel thumbnail.
- Only articles with all exact markers `摘要`, `为什么值得阅读`, `来源`, and `阅读原文 ↗` qualify for cleanup.
- Cleanup must emit a complete JSON manifest before deletion and require `--apply`.
- No production deployment or remote database synchronization.

---

### Task 1: Decode modern source images

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/ingest/media/localizeArticleImages.js`
- Modify: `test/tasks/contentIngest.media.test.js`

**Interfaces:**
- Consumes: `{ buffer: Buffer }` returned by `safeRemoteFetch`.
- Produces: `localizeArticleImages({ candidateId, images, outputDir, fetchImage, maxImages })` with the existing asset result shape.

- [ ] **Step 1: Add a failing WebP test**

Generate a WebP buffer with Sharp, pass it through `localizeArticleImages`, and assert that a JPEG plus thumbnail is created:

```js
const sharp = require('sharp');
const webp = await sharp({
  create: { width: 1200, height: 675, channels: 4, background: '#336699' },
}).webp().toBuffer();
```

- [ ] **Step 2: Run the media test and verify the current Jimp decoder rejects WebP**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.media.test.js
```

Expected: the WebP case fails with `No usable article image passed validation`.

- [ ] **Step 3: Install Sharp and replace Jimp in the ingest media path**

Run:

```bash
pnpm add sharp@0.35.3
```

Use `sharp(buffer).rotate().metadata()`, reject dimensions below `480x270`, emit a maximum-width-1600 JPEG at quality 82, and emit a width-320 JPEG thumbnail at quality 80. Keep the existing filenames, hashes, metadata, cleanup behavior, and three-image cap.

- [ ] **Step 4: Run the media tests**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.media.test.js
```

Expected: all media tests pass, including WebP.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingest/media/localizeArticleImages.js test/tasks/contentIngest.media.test.js
git commit -m "feat(ingest): decode modern source images"
```

### Task 2: Build editable raw Tiptap documents

**Files:**
- Create: `src/ingest/domain/buildRawArticleContent.js`
- Create: `test/tasks/contentIngest.rawContent.test.js`

**Interfaces:**
- Consumes: `{ page, source, images }`, where `page.sections` contains source headings and paragraphs and each image has `{ id, src, alt, caption, isCover }`.
- Produces: `buildRawArticleContent({ page, source, images }) -> { type: 'doc', content: Node[] }`.
- Produces: `rawArticleExcerpt(page, maxLength = 240) -> string`.

- [ ] **Step 1: Write failing raw-content tests**

Assert that:

```js
const doc = buildRawArticleContent({ page, source, images });
assert.equal(doc.type, 'doc');
assert.deepEqual(
  doc.content.filter((node) => node.type === 'heading').map((node) => node.content[0].text),
  ['API pricing', 'Workflow value', 'Policy controls', 'Source'],
);
assert.deepEqual(
  doc.content.filter((node) => node.type === 'image').map((node) => node.attrs.imageId),
  [501, 502, 503],
);
assert.match(JSON.stringify(doc), /Read the original article/);
assert.equal(rawArticleExcerpt(page).length <= 240, true);
```

The builder must preserve source paragraph text exactly after whitespace normalization and must not create `摘要` or `为什么值得阅读` headings.

- [ ] **Step 2: Run the test and verify missing-module failure**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.rawContent.test.js
```

Expected: FAIL because `buildRawArticleContent` does not exist.

- [ ] **Step 3: Implement the raw builder**

Create paragraph, heading, image, and linked-source Tiptap nodes. Insert the cover after the first useful paragraph and distribute remaining images between sections. Add a final level-2 `Source` heading with source name, date, and a `Read the original article ↗` link.

- [ ] **Step 4: Run the raw-content tests**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.rawContent.test.js
```

Expected: all raw-content tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/domain/buildRawArticleContent.js test/tasks/contentIngest.rawContent.test.js
git commit -m "feat(ingest): build editable raw articles"
```

### Task 3: Add the model-free raw backfill command

**Files:**
- Create: `src/ingest/pipeline/backfillRawArticles.js`
- Create: `test/tasks/contentIngest.rawBackfill.test.js`
- Modify: `src/ingest/cli.js`
- Modify: `test/tasks/contentIngest.cli.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing repository methods `listPublishedCandidatesByIds(ids)` and `replacePublishedArticle(input)`.
- Produces: `backfillRawArticles({ repository, extractor, localizeImages, authorIds, ids, now, days, outputDir, publicBaseURL })`.
- Produces CLI: `pnpm ingest backfill-raw --ids 54 --limit 1`.

- [ ] **Step 1: Write failing pipeline and CLI tests**

The pipeline test must provide an extractor page containing English source text and assert:

```js
assert.equal(result.updated, 1);
assert.equal(replacement.title, page.title.slice(0, 50));
assert.equal(replacement.excerpt, page.sections[0].paragraphs[0].slice(0, 240));
assert.doesNotMatch(JSON.stringify(replacement.buildContent(imageRows)), /为什么值得阅读/);
assert.equal(enricherCalls, 0);
```

CLI tests must require 1–5 unique IDs for `backfill-raw` and confirm that `createDefaultActions` does not instantiate `createRichArticleEnricher` for this action.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.rawBackfill.test.js test/tasks/contentIngest.cli.test.js
```

Expected: FAIL because `backfill-raw` and its pipeline do not exist.

- [ ] **Step 3: Implement the raw pipeline**

Reuse the asset promotion and removal helpers from `backfillRichArticles`. Replace `article.titleZh` and `article.lead` with the source page title and `rawArticleExcerpt(page)`, and call `buildRawArticleContent`.

- [ ] **Step 4: Wire the CLI and document the operational command**

Add `backfill-raw` to `KNOWN_COMMANDS`, apply the same ID validation as rich backfill, and compose it from `safeRemoteFetch`, `extractArticlePage`, `localizeArticleImages`, and the existing rich article repository. Document raw backfill as the default manual and scheduled content preparation path; do not add Ollama variables to the example.

- [ ] **Step 5: Run the raw pipeline and CLI tests**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.rawBackfill.test.js test/tasks/contentIngest.cli.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/pipeline/backfillRawArticles.js test/tasks/contentIngest.rawBackfill.test.js src/ingest/cli.js test/tasks/contentIngest.cli.test.js README.md
git commit -m "feat(ingest): add model-free raw backfill"
```

### Task 4: Add exact placeholder cleanup

**Files:**
- Create: `src/ingest/domain/isPlaceholderArticle.js`
- Create: `src/ingest/pipeline/purgePlaceholderArticles.js`
- Create: `test/tasks/contentIngest.placeholderCleanup.test.js`
- Modify: `src/ingest/repositories/richArticleRepository.js`
- Modify: `test/tasks/contentIngest.richRepository.test.js`
- Modify: `src/ingest/cli.js`
- Modify: `test/tasks/contentIngest.cli.test.js`

**Interfaces:**
- Produces: `isPlaceholderArticle(content) -> boolean`.
- Produces repository methods `listPlaceholderArticles()` and `deletePlaceholderArticles(ids)`.
- Produces: `purgePlaceholderArticles({ repository, apply }) -> { matched, deleted, manifest }`.
- Produces CLI dry run: `pnpm ingest purge-placeholders`.
- Produces CLI apply: `pnpm ingest purge-placeholders --apply`.

- [ ] **Step 1: Write failing predicate, repository, pipeline, and CLI tests**

The predicate must return true only for a Tiptap document containing the four exact markers. A rich article containing a generic `Source` heading must remain false.

The repository delete test must assert a transaction with:

```sql
SELECT ... FROM article ... FOR UPDATE;
DELETE FROM article WHERE id = ANY(?::bigint[]);
UPDATE ingest_candidate
SET status = 'rejected',
    failure_reason = 'Removed fixed-format placeholder article',
    updated_at = clock_timestamp()
WHERE id = ANY(?::bigint[]);
```

The pipeline must return the full manifest without mutation when `apply` is false.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.placeholderCleanup.test.js test/tasks/contentIngest.richRepository.test.js test/tasks/contentIngest.cli.test.js
```

Expected: FAIL because cleanup interfaces do not exist.

- [ ] **Step 3: Implement exact detection and transactional deletion**

Query candidate-linked articles, validate the JSON in JavaScript with `isPlaceholderArticle`, then pass the exact IDs to the transaction. Recheck locked rows with the same predicate before deletion. Return full manifest data before deleting.

- [ ] **Step 4: Add CLI apply-flag parsing**

Parse `--apply` as a boolean flag only for `purge-placeholders`. Dry run must be the default.

- [ ] **Step 5: Run cleanup tests**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.placeholderCleanup.test.js test/tasks/contentIngest.richRepository.test.js test/tasks/contentIngest.cli.test.js
```

Expected: all cleanup tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/domain/isPlaceholderArticle.js src/ingest/pipeline/purgePlaceholderArticles.js test/tasks/contentIngest.placeholderCleanup.test.js src/ingest/repositories/richArticleRepository.js test/tasks/contentIngest.richRepository.test.js src/ingest/cli.js test/tasks/contentIngest.cli.test.js
git commit -m "feat(ingest): purge fixed-format placeholders"
```

### Task 5: Apply locally and verify

**Files:**
- Runtime output only: local PostgreSQL database and `public/img`

**Interfaces:**
- Consumes candidate `54`, existing users `1,2,3,4,5`, and local database `coderx`.
- Produces raw GitHub article `150`, then removes remaining placeholder articles.

- [ ] **Step 1: Run all ingest tests**

Run:

```bash
node --test --test-concurrency=1 "test/tasks/contentIngest.*.test.js"
```

Expected: all ingest tests pass.

- [ ] **Step 2: Replace GitHub article 150 with raw source content**

Run:

```bash
PGPASSWORD=123456 PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=coderx PGUSER=postgres \
INGEST_AUTHOR_IDS=3 PUBLIC_API_ORIGIN=http://192.168.3.96:8000 \
pnpm ingest backfill-raw --ids 54 --limit 1
```

Expected: `updated: 1`, at least one local image, and no model request.

- [ ] **Step 3: Dry-run and apply placeholder cleanup**

Run:

```bash
PGPASSWORD=123456 PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=coderx PGUSER=postgres \
pnpm ingest purge-placeholders
```

Expected dry-run IDs: `144,145,147,148,149`.

Then run the same command with `--apply`. Expected: `deleted: 5`.

- [ ] **Step 4: Verify database, API, and images**

Use SQL to assert:

- article 150 contains source English headings and paragraphs;
- article 150 has one to three local images;
- the five authors across 143, 146, 150, 151, 152 are distinct existing users;
- article dates fall in the previous 30 days;
- the exact placeholder query returns zero rows.

Use the local article API to confirm article 150 renders and every image URL returns HTTP 200.

- [ ] **Step 5: Run the full application suite**

Run:

```bash
PGPASSWORD=123456 PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=coderx PGUSER=postgres \
node --test --test-concurrency=1 "test/service/*.test.js" "test/tasks/*.test.js" "test/controller/*.test.js"
```

Expected: all tests pass.

- [ ] **Step 6: Commit any verification-driven fixes**

```bash
git status --short
git add src/ingest test/tasks README.md package.json pnpm-lock.yaml
git commit -m "fix(ingest): harden raw article backfill"
```

Skip this commit when verification required no additional code changes.
