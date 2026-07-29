# Rich AI Article Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade five existing local AI aggregation articles into image-backed, 800–1500 character Chinese articles with deterministic assignment to approved existing users and dates spread across the last 30 days.

**Architecture:** A framework-independent extraction pipeline fetches allowlisted public pages, extracts readable source material and image candidates, asks the existing remote Ollama service for a structured Chinese rewrite, downloads validated images into CoderX storage, and atomically updates existing article rows plus image metadata. Author and backfill-date assignment are pure deterministic domain functions so retries do not change the result.

**Tech Stack:** Node.js CommonJS, `@mozilla/readability`, `happy-dom`, Vercel AI SDK, Zod, Jimp, PostgreSQL, Tiptap JSON, Node test runner, pnpm.

## Global Constraints

- First run updates exactly five existing local articles from five different sources; it does not connect to production.
- Each article contains 800–1500 Chinese characters and 3–6 meaningful sections.
- Each article has at least one locally stored cover image and at most two additional body images.
- Authors come only from the active existing-user IDs configured in `INGEST_AUTHOR_IDS`; no new users are created.
- The five display dates occupy five different buckets within the last 30 days and remain stable across retries.
- Source name, original URL, original publication time, and “基于公开来源整理” disclosure remain visible.
- Source text is rewritten, not copied or fully translated.
- URLs resolving to loopback, private, link-local, multicast, or unspecified IP ranges are rejected.

---

### Task 1: Safe readable-page extraction

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/ingest/extraction/safeRemoteFetch.js`
- Create: `src/ingest/extraction/extractArticlePage.js`
- Create: `test/fixtures/ingest/article-page.html`
- Create: `test/tasks/contentIngest.extraction.test.js`

**Interfaces:**
- Produces: `assertPublicHttpUrl(url, { lookup }) -> Promise<URL>`
- Produces: `safeRemoteFetch(url, { fetchImpl, lookup, timeoutMs, maxBytes, maxRedirects }) -> Promise<{ url, contentType, buffer }>`
- Produces: `extractArticlePage({ canonicalUrl, html }) -> { title, canonicalUrl, byline, publishedAt, textContent, sections, images }`

- [ ] **Step 1: Add Readability**

Run:

```bash
pnpm add @mozilla/readability
```

Expected: `package.json` and `pnpm-lock.yaml` include `@mozilla/readability`.

- [ ] **Step 2: Write failing URL-safety and extraction tests**

Create tests that inject DNS lookup and fetch responses so they do not use the network:

```js
test('assertPublicHttpUrl rejects private and loopback destinations', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('http://internal.example/a', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    /public internet address/,
  );
});

test('extractArticlePage returns readable sections and absolute image candidates', () => {
  const page = extractArticlePage({
    canonicalUrl: 'https://news.example/posts/ai',
    html: fixtureHtml,
  });
  assert.equal(page.canonicalUrl, 'https://news.example/posts/ai');
  assert.ok(page.textContent.length >= 600);
  assert.ok(page.sections.length >= 4);
  assert.equal(page.images[0].url, 'https://news.example/media/cover.jpg');
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
node --test test/tasks/contentIngest.extraction.test.js
```

Expected: FAIL because the extraction modules do not exist.

- [ ] **Step 4: Implement safe fetching**

`safeRemoteFetch.js` must:

- accept only `http:` and `https:`;
- resolve every redirect target before requesting it;
- reject IPv4 private/loopback/link-local/multicast/unspecified ranges and IPv6 loopback, unique-local and link-local ranges;
- use `redirect: 'manual'`;
- abort after `timeoutMs`;
- stop reading after `maxBytes`;
- require an HTML response for article pages.

Export `assertPublicHttpUrl`, `isPublicAddress`, and `safeRemoteFetch` for focused tests.

- [ ] **Step 5: Implement Readability extraction**

Use `happy-dom` to parse HTML and `new Readability(document).parse()` for the main article. Normalize whitespace, resolve canonical and image URLs against the final page URL, deduplicate paragraphs and images, and return only `h1`–`h3` headings plus paragraphs. Reject pages with fewer than 600 source characters or four paragraphs.

- [ ] **Step 6: Run extraction tests**

Run:

```bash
node --test test/tasks/contentIngest.extraction.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingest/extraction test/fixtures/ingest/article-page.html test/tasks/contentIngest.extraction.test.js
git commit -m "feat(ingest): extract safe readable source pages"
```

### Task 2: Structured long-form rewriting and Tiptap rendering

**Files:**
- Create: `src/ingest/enrichment/createRichArticleEnricher.js`
- Create: `src/ingest/domain/buildRichArticleContent.js`
- Create: `test/tasks/contentIngest.richContent.test.js`

**Interfaces:**
- Consumes: the `extractArticlePage` result from Task 1.
- Produces: `createRichArticleEnricher({ baseURL, model, generateTextImpl }).enrich(page)`
- Produces: `buildRichArticleContent({ article, source, images }) -> TiptapDoc`
- The rich result is `{ titleZh, lead, sections: [{ heading, paragraphs }], conclusion, keywords }`.
- Image inputs are `{ id, src, alt, caption, isCover }`.

- [ ] **Step 1: Write failing schema and rendering tests**

Cover these assertions:

```js
assert.equal(result.sections.length, 3);
assert.ok(chineseLength(result) >= 800);
assert.ok(chineseLength(result) <= 1500);
assert.deepEqual(
  doc.content.filter((node) => node.type === 'image').map((node) => node.attrs.imageId),
  [501, 502],
);
assert.match(lastParagraphText(doc), /基于公开来源整理/);
assert.match(lastLink(doc).attrs.href, /^https:\/\/news\.example\//);
```

Also reject outputs with fewer than three sections, paragraphs absent from the structured schema, or total Chinese length outside 800–1500.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
node --test test/tasks/contentIngest.richContent.test.js
```

Expected: FAIL because the rich enricher and renderer do not exist.

- [ ] **Step 3: Implement the rich Ollama schema**

Use Zod:

```js
const richArticleSchema = z.object({
  titleZh: z.string().trim().min(8).max(80),
  lead: z.string().trim().min(60).max(240),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(2).max(40),
        paragraphs: z.array(z.string().trim().min(40).max(320)).min(1).max(3),
      }),
    )
    .min(3)
    .max(6),
  conclusion: z.string().trim().min(40).max(240),
  keywords: z.array(z.string().trim().min(1).max(30)).min(2).max(8),
});
```

The prompt includes only extracted title, byline, date, headings and paragraphs. It explicitly forbids adding unsupported names, numbers, places or personal experience.

- [ ] **Step 4: Implement rich Tiptap rendering**

Build a document with lead paragraph, cover image, section headings and paragraphs, up to two body images distributed after sections, conclusion, source disclosure, and a `noopener noreferrer` original link. Image nodes use:

```js
{
  type: 'image',
  attrs: {
    imageId: image.id,
    src: image.src,
    alt: image.alt || '',
    title: image.caption || null,
  },
}
```

- [ ] **Step 5: Run rich-content tests**

Run:

```bash
node --test test/tasks/contentIngest.richContent.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/enrichment/createRichArticleEnricher.js src/ingest/domain/buildRichArticleContent.js test/tasks/contentIngest.richContent.test.js
git commit -m "feat(ingest): generate structured Chinese articles"
```

### Task 3: Existing-user rotation and deterministic date buckets

**Files:**
- Modify: `src/ingest/config/runtime.js`
- Modify: `.env.example`
- Create: `src/ingest/domain/assignBackfillMetadata.js`
- Create: `test/tasks/contentIngest.backfillMetadata.test.js`
- Create: `test/tasks/contentIngest.runtime.test.js`

**Interfaces:**
- Produces: `parseIdList(value) -> number[]`
- Produces: `assignAuthors(candidates, authorIds) -> Map<candidateId, authorId>`
- Produces: `assignBackfillDates(candidates, { now, days }) -> Map<candidateId, Date>`
- Runtime config adds `authorIds: number[]` from `INGEST_AUTHOR_IDS`.

- [ ] **Step 1: Write failing metadata tests**

```js
test('assignAuthors uses only configured IDs, avoids adjacent repeats and is stable', () => {
  const first = assignAuthors(candidates, [1, 2, 3, 4, 5]);
  const second = assignAuthors(candidates, [1, 2, 3, 4, 5]);
  assert.deepEqual([...first], [...second]);
  assert.notEqual(first.get(candidates[0].id), first.get(candidates[1].id));
  assert.equal(new Set(first.values()).size, 5);
});

test('assignBackfillDates fills five stable buckets in the previous 30 days', () => {
  const result = [...assignBackfillDates(candidates, { now, days: 30 }).values()];
  assert.equal(new Set(result.map((date) => Math.floor((now - date) / (6 * DAY_MS)))).size, 5);
});
```

Test runtime parsing with `INGEST_AUTHOR_IDS=1,2,3,4,5`; reject duplicates, unsafe integers and fewer than two IDs when rich backfill is invoked.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
node --test test/tasks/contentIngest.backfillMetadata.test.js test/tasks/contentIngest.runtime.test.js
```

Expected: FAIL because the assignment module and runtime field do not exist.

- [ ] **Step 3: Implement stable assignment**

Sort candidates by canonical URL, hash the complete ordered URL set with SHA-256, and use the first eight hex digits as the starting index in the author pool. Assign authors by cycling from that index; when the pool has at least as many authors as candidates, every candidate receives a distinct author. For dates, divide 30 days into `candidateCount` equal buckets and use each canonical URL hash for the in-bucket offset. Clamp every result to `[now - 30 days, now - 1 minute]`.

- [ ] **Step 4: Run metadata tests**

Run:

```bash
node --test test/tasks/contentIngest.backfillMetadata.test.js test/tasks/contentIngest.runtime.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/config/runtime.js .env.example src/ingest/domain/assignBackfillMetadata.js test/tasks/contentIngest.backfillMetadata.test.js test/tasks/contentIngest.runtime.test.js
git commit -m "feat(ingest): rotate backfill authors and dates"
```

### Task 4: Image localization and atomic article replacement

**Files:**
- Create: `src/ingest/media/localizeArticleImages.js`
- Create: `src/ingest/repositories/richArticleRepository.js`
- Create: `test/tasks/contentIngest.media.test.js`
- Create: `test/tasks/contentIngest.richRepository.test.js`

**Interfaces:**
- Consumes: extracted image candidates from Task 1 and `safeRemoteFetch`.
- Produces: `localizeArticleImages({ images, fetchImage, outputDir, maxImages }) -> Promise<{ assets, cleanup }>`
- Asset shape: `{ filename, mimetype: 'image/jpeg', size, width, height, alt, caption, temporaryPath }`.
- Produces: `createRichArticleRepository(database).replacePublishedArticle(input)`.
- `replacePublishedArticle` input includes `{ articleId, candidateId, authorId, createAt, title, excerpt, assets, buildContent }`.

- [ ] **Step 1: Write failing media tests**

Use generated in-memory Jimp images. Assert that small images are dropped, duplicate URLs are downloaded once, at most three JPEG assets are returned, filenames are unique, and `cleanup()` removes temporary files.

- [ ] **Step 2: Write failing repository transaction tests**

The mock database test must verify this statement order:

1. lock the article joined to `article_source` by candidate ID;
2. validate the selected existing user has `status = 0` and a non-empty profile avatar;
3. clear previous ingest-owned image rows for this article;
4. insert each `file` row with `article_id` and `file_type = 'image'`;
5. insert `image_meta`, setting only the first image as cover;
6. call `buildContent(imageRows)` and update `article.user_id`, `title`, `content`, `excerpt`, `create_at`, and `update_at`;
7. commit.

Also assert rollback when the article mapping, user, image insertion or article update fails.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
node --test test/tasks/contentIngest.media.test.js test/tasks/contentIngest.richRepository.test.js
```

Expected: FAIL because the media and repository modules do not exist.

- [ ] **Step 4: Implement image localization**

Download at most six candidates until three images pass. Decode with `Jimp.read(buffer)`, reject dimensions below 480×270, resize images wider than 1600 pixels, encode JPEG at quality 82, and write both full-size and `-small` 320-pixel variants into a temporary directory. Sanitize alt text to 180 characters.

- [ ] **Step 5: Implement atomic replacement**

Use one PostgreSQL transaction per article. Insert image metadata with `RETURNING id`, pass those IDs to `buildContent`, and update the existing article in place. Mark replacement images with a deterministic `ingest-<candidateId>-` filename prefix so retries replace only ingestion-owned files and never delete user-uploaded files.

- [ ] **Step 6: Run media and repository tests**

Run:

```bash
node --test test/tasks/contentIngest.media.test.js test/tasks/contentIngest.richRepository.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/media/localizeArticleImages.js src/ingest/repositories/richArticleRepository.js test/tasks/contentIngest.media.test.js test/tasks/contentIngest.richRepository.test.js
git commit -m "feat(ingest): persist rich article images atomically"
```

### Task 5: Rich-backfill pipeline and CLI

**Files:**
- Create: `src/ingest/pipeline/backfillRichArticles.js`
- Modify: `src/ingest/cli.js`
- Modify: `README.md`
- Create: `test/tasks/contentIngest.richBackfill.test.js`
- Modify: `test/tasks/contentIngest.cli.test.js`

**Interfaces:**
- Produces: `backfillRichArticles({ repository, extractor, enricher, localizeImages, authorIds, ids, now, days, outputDir })`.
- CLI command: `pnpm ingest backfill-rich --ids <candidateIds> --limit 5`.
- Result: `{ attempted, updated, failed, articles: [{ candidateId, articleId, authorId, createAt, imageCount }], failures: [{ candidateId, reason }] }`.

- [ ] **Step 1: Write failing pipeline tests**

Use five candidates from five sources. Assert source diversity, per-item failure isolation, stable author/date inputs, minimum one image, and no repository write when extraction, enrichment or image localization fails.

- [ ] **Step 2: Write failing CLI tests**

Assert `backfill-rich` is recognized, requires explicit `--ids`, rejects more than five IDs for the first-run command, and never runs from scheduled `run`.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
node --test test/tasks/contentIngest.richBackfill.test.js test/tasks/contentIngest.cli.test.js
```

Expected: FAIL because the command and pipeline do not exist.

- [ ] **Step 4: Implement orchestration**

For each candidate:

1. fetch and extract the page;
2. generate the rich Chinese structure;
3. localize images;
4. move temporary full-size and small images into `public/img`;
5. call `replacePublishedArticle`;
6. after commit, delete replaced ingest-owned files and clean temporary paths.

If moving a file or database replacement fails, remove every new final file copied for that item. The database method returns the old ingest-owned filenames only after a successful commit, so they can be deleted without risking rollback data. Continue with the next candidate and collect the failure reason.

- [ ] **Step 5: Wire the explicit CLI command**

Compose Task 1–4 modules only inside the new CLI action. `backfill-rich` must not be included in the scheduler's `run` command and must require `INGEST_AUTHOR_IDS`.

- [ ] **Step 6: Document local usage and source-license boundary**

Add:

```bash
INGEST_AUTHOR_IDS=1,2,3,4,5 \
INGEST_OLLAMA_BASE_URL=http://100.119.144.76:11434/v1 \
INGEST_OLLAMA_MODEL=qwen2.5:7b \
pnpm ingest backfill-rich --ids 70,21,54,149,60 --limit 5
```

Document that production source images require an allowlist whose reuse rights have been reviewed.

- [ ] **Step 7: Run pipeline and CLI tests**

Run:

```bash
node --test test/tasks/contentIngest.richBackfill.test.js test/tasks/contentIngest.cli.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ingest/pipeline/backfillRichArticles.js src/ingest/cli.js README.md test/tasks/contentIngest.richBackfill.test.js test/tasks/contentIngest.cli.test.js
git commit -m "feat(ingest): add explicit rich backfill command"
```

### Task 6: Execute and verify the first five local articles

**Files:**
- Local database: `coderx`
- Local generated images: `public/img/ingest-*`
- No production files or databases.

**Interfaces:**
- Consumes candidate IDs `70,21,54,149,60` representing AWS, NVIDIA, GitHub, Microsoft and Google.

- [ ] **Step 1: Snapshot current rows**

Run:

```bash
PGPASSWORD=123456 psql -X -h 127.0.0.1 -p 5432 -U postgres -d coderx \
  -c "SELECT a.id,a.user_id,a.title,a.create_at,ars.candidate_id FROM article a JOIN article_source ars ON ars.article_id=a.id WHERE ars.candidate_id=ANY(ARRAY[70,21,54,149,60]::bigint[]) ORDER BY ars.candidate_id;"
```

Expected: five mapped published articles.

- [ ] **Step 2: Run targeted rich backfill**

Run:

```bash
PGPASSWORD=123456 PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=coderx PGUSER=postgres \
INGEST_AUTHOR_IDS=1,2,3,4,5 \
INGEST_OLLAMA_BASE_URL=http://100.119.144.76:11434/v1 \
INGEST_OLLAMA_MODEL=qwen2.5:7b \
pnpm ingest backfill-rich --ids 70,21,54,149,60 --limit 5
```

Expected: `attempted: 5`, `updated: 5`, `failed: 0`.

- [ ] **Step 3: Run the complete test suite serially**

Run:

```bash
pnpm test -- --test-concurrency=1
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Verify database invariants**

Run:

```bash
PGPASSWORD=123456 psql -X -h 127.0.0.1 -p 5432 -U postgres -d coderx -v ON_ERROR_STOP=1 \
  -c "SELECT a.id,u.name,a.create_at,length(a.excerpt),count(f.id) images,bool_or(im.is_cover) has_cover FROM article a JOIN \"user\" u ON u.id=a.user_id JOIN article_source ars ON ars.article_id=a.id LEFT JOIN file f ON f.article_id=a.id AND f.file_type='image' LEFT JOIN image_meta im ON im.file_id=f.id WHERE ars.candidate_id=ANY(ARRAY[70,21,54,149,60]::bigint[]) GROUP BY a.id,u.name,a.create_at ORDER BY a.create_at DESC;"
```

Expected: five rows with five distinct approved existing authors, at least one image and one cover per row, and dates spanning five 30-day buckets.

- [ ] **Step 5: Verify API and image responses**

Run:

```bash
curl --fail --silent 'http://127.0.0.1:8000/article?offset=0&limit=20&tagId=13&pageOrder=date' | jq '.data.result[] | select(.id >= 143 and .id <= 152) | {id, author, createAt, cover}'
curl --fail --silent 'http://127.0.0.1:8000/article/143' | jq '{title: .data.title, textLength: (.data.contentHtml | length), images: (.data.images | length)}'
```

Expected: list results include cover URLs and varied authors/dates; detail contains long HTML and local image records.

- [ ] **Step 6: Inspect generated covers**

Open the five `public/img/ingest-*-small.jpg` images and confirm they are relevant, non-blank, correctly oriented and free of obvious logos-only or tracking-pixel selections.

- [ ] **Step 7: Commit any verification-only documentation changes**

If README or fixtures changed during verification:

```bash
git add README.md test/fixtures
git commit -m "docs(ingest): document rich backfill verification"
```

If no tracked files changed, do not create an empty commit.
