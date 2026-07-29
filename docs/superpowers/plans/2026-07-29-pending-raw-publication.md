# Pending Raw Article Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `backfill-raw` so explicitly selected unmapped `pending` candidates are published as new source-language CoderX articles while existing mapped candidates retain their replacement behavior.

**Architecture:** Add an eligible raw-candidate lookup and a transactional `publishRawArticle` method to the existing rich-article repository. The raw pipeline chooses create or replace from the candidate mapping, retains per-candidate source extraction and asset staging, and reports separate `created`, `updated`, and `failed` counts without adding another CLI command.

**Tech Stack:** Node.js CommonJS, PostgreSQL, Tiptap JSON, Sharp, `node:test`, pnpm.

## Global Constraints

- Continue to use only `pnpm ingest backfill-raw`; do not add a second publication command.
- Preserve source-language title, headings, paragraphs, byline, publication time, canonical URL, and useful source images.
- Do not translate, rewrite, summarize, call Ollama, download a model, or change VPN state.
- Accept only 1–5 unique explicit candidate IDs and require one distinct source per article.
- Use only existing active users and the existing `人工智能` tag.
- A failed candidate must leave no article, metadata rows, or promoted files.
- Keep mapped published-candidate replacement behavior backward compatible.
- Operate on the local database and local assets only; do not deploy or mutate production.

---

### Task 1: Add eligible candidate lookup and transactional raw publication

**Files:**
- Modify: `src/ingest/repositories/richArticleRepository.js`
- Modify: `test/tasks/contentIngest.richRepository.test.js`

**Interfaces:**
- Consumes: `listRawCandidatesByIds(ids: number[])`.
- Produces: eligible candidates with `{ id, articleId, status, sourceId, canonicalUrl, titleOriginal, sourcePublishedAt, contentMode, licenseCode, sourceName }`.
- Consumes: `publishRawArticle({ candidateId, authorId, createAt, tagName, title, excerpt, assets, buildContent })`.
- Produces: `{ articleId, images, oldFilenames: [] }`.

- [ ] **Step 1: Write a failing lookup test**

Add a repository test whose fake root query returns one published candidate and
one pending candidate:

```js
test('listRawCandidatesByIds accepts mapped published and unmapped pending candidates', async () => {
  const database = createDatabase();
  database.execute = async (statement, params = []) => {
    database.calls.push({ op: 'rootExecute', statement, params });
    return [
      [
        {
          id: 70,
          articleId: 143,
          status: 'published',
          sourceId: 1,
          canonicalUrl: 'https://aws.example/article',
          titleOriginal: 'AWS article',
          sourcePublishedAt: '2026-07-24T00:00:00.000Z',
          contentMode: 'summary',
          licenseCode: 'link-only',
          sourceName: 'AWS',
        },
        {
          id: 3,
          articleId: null,
          status: 'pending',
          sourceId: 2,
          canonicalUrl: 'https://openai.com/article',
          titleOriginal: 'OpenAI article',
          sourcePublishedAt: '2026-07-28T00:00:00.000Z',
          contentMode: 'summary',
          licenseCode: 'link-only',
          sourceName: 'OpenAI',
        },
      ],
      [],
    ];
  };
  const repository = createRichArticleRepository(database);

  const rows = await repository.listRawCandidatesByIds([70, 3]);

  assert.deepEqual(rows.map((row) => [row.id, row.status]), [
    [3, 'pending'],
    [70, 'published'],
  ]);
  const call = database.calls.find((item) => item.op === 'rootExecute');
  assert.match(call.statement, /c\.status = 'pending'[\s\S]*c\.article_id IS NULL/i);
  assert.match(call.statement, /c\.status = 'published'[\s\S]*c\.article_id IS NOT NULL/i);
  assert.match(call.statement, /NOT EXISTS[\s\S]*article_source/i);
  assert.match(call.statement, /EXISTS[\s\S]*article_source/i);
  assert.deepEqual(call.params, [[70, 3]]);
});
```

- [ ] **Step 2: Run the lookup test and verify RED**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.richRepository.test.js
```

Expected: FAIL because `repository.listRawCandidatesByIds` does not exist.

- [ ] **Step 3: Implement the eligible lookup**

Add `listRawCandidatesByIds` beside `listPublishedCandidatesByIds`:

```js
async function listRawCandidatesByIds(ids) {
  const safeIds = Array.isArray(ids) ? ids.map(Number) : [];
  if (
    safeIds.length === 0 ||
    safeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(safeIds).size !== safeIds.length
  ) {
    throw new Error('ids must be unique positive integers');
  }
  const [rows] = await database.execute(
    `
      SELECT
        c.id,
        c.article_id AS "articleId",
        c.status,
        c.source_id AS "sourceId",
        c.canonical_url AS "canonicalUrl",
        c.title_original AS "titleOriginal",
        c.source_published_at AS "sourcePublishedAt",
        c.content_mode AS "contentMode",
        c.license_code AS "licenseCode",
        s.name AS "sourceName"
      FROM ingest_candidate c
      JOIN ingest_source s ON s.id = c.source_id
      WHERE c.id = ANY(?::bigint[])
        AND (
          (
            c.status = 'pending'
            AND c.article_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM article_source ars
              WHERE ars.candidate_id = c.id
            )
          )
          OR
          (
            c.status = 'published'
            AND c.article_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM article_source ars
              WHERE ars.candidate_id = c.id
                AND ars.article_id = c.article_id
            )
          )
        )
      ORDER BY c.id;
    `,
    [safeIds],
  );
  return rows;
}
```

Export it from the repository result object without changing
`listPublishedCandidatesByIds`, because `backfill-rich` still requires only
mapped articles.

- [ ] **Step 4: Run the repository test and verify GREEN**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.richRepository.test.js
```

Expected: all current repository tests plus the new lookup test pass.

- [ ] **Step 5: Write failing transactional publication tests**

Add a pending-candidate input helper:

```js
function buildPendingInput(overrides = {}) {
  return {
    candidateId: 3,
    authorId: 2,
    createAt: new Date('2026-07-28T10:00:00.000Z'),
    tagName: '人工智能',
    title: 'Introducing the ChatGPT for small business program',
    excerpt: 'Small businesses can use ChatGPT to support daily work.',
    assets: [
      {
        filename: 'ingest-3-cover.jpg',
        mimetype: 'image/jpeg',
        size: 1000,
        width: 1200,
        height: 675,
        isCover: true,
        src: 'http://localhost:8000/article/images/ingest-3-cover.jpg',
      },
    ],
    buildContent(images) {
      return {
        type: 'doc',
        content: images.map((image) => ({
          type: 'image',
          attrs: { imageId: image.id, src: image.src },
        })),
      };
    },
    ...overrides,
  };
}
```

Use a fake connection that returns:

- the locked pending candidate with all source fields;
- one active user row;
- tag `{ id: 13 }`;
- no conflicting `article_source`;
- inserted article ID `601`;
- inserted image ID `701`.

Assert the exact transaction order and parameters:

```js
test('publishRawArticle atomically creates article, image, tag, source and candidate mapping', async () => {
  const database = createPendingPublicationDatabase();
  const repository = createRichArticleRepository(database);

  const result = await repository.publishRawArticle(buildPendingInput());

  assert.equal(result.articleId, 601);
  assert.deepEqual(result.images.map((image) => image.id), [701]);
  assert.deepEqual(result.oldFilenames, []);

  const statements = database.calls.filter((call) => call.statement);
  assert.match(statements[0].statement, /FROM ingest_candidate[\s\S]*FOR UPDATE OF c/i);
  assert.match(statements[1].statement, /FROM "user"[\s\S]*profile/i);
  assert.match(statements[2].statement, /FROM tag/i);
  assert.match(statements[3].statement, /FROM article_source/i);
  assert.match(statements[4].statement, /INSERT INTO article/i);
  assert.match(statements[5].statement, /INSERT INTO file/i);
  assert.match(statements[6].statement, /INSERT INTO image_meta/i);
  assert.match(statements[7].statement, /UPDATE article/i);
  assert.match(statements[8].statement, /INSERT INTO article_tag/i);
  assert.match(statements[9].statement, /INSERT INTO article_source/i);
  assert.match(statements[10].statement, /UPDATE ingest_candidate/i);
  assert.deepEqual(
    database.calls
      .filter((call) => call.op !== 'execute')
      .map((call) => call.op),
    ['getConnection', 'begin', 'commit', 'release'],
  );
});
```

Add parameterized failure tests for:

- candidate missing or no longer pending;
- inactive/missing author;
- missing `人工智能` tag;
- conflicting canonical URL;
- failed candidate status update;
- any database error after the article insert.

Each case must assert `begin → rollback → release` and no commit.

- [ ] **Step 6: Run publication tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.richRepository.test.js
```

Expected: FAIL because `repository.publishRawArticle` does not exist.

- [ ] **Step 7: Implement `publishRawArticle`**

Validate all IDs, `createAt`, text fields, `tagName`, assets, and
`buildContent`. Inside one connection transaction:

```js
const [candidateRows] = await connection.execute(
  `
    SELECT
      c.id,
      c.source_id AS "sourceId",
      c.canonical_url AS "canonicalUrl",
      c.title_original AS "titleOriginal",
      c.source_published_at AS "sourcePublishedAt",
      c.content_mode AS "contentMode",
      c.license_code AS "licenseCode"
    FROM ingest_candidate c
    WHERE c.id = ?
      AND c.status = 'pending'
      AND c.article_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM article_source ars WHERE ars.candidate_id = c.id
      )
    FOR UPDATE OF c;
  `,
  [candidateId],
);
```

Then:

1. verify the assigned user is active and has an avatar, using the same query
   as `replacePublishedArticle`;
2. resolve `tag.id` by exact `tagName`;
3. reject any row found by
   `SELECT article_id FROM article_source WHERE canonical_url = ? OR candidate_id = ? LIMIT 1`;
4. insert the article with an empty `{ type: 'doc', content: [] }` document and
   explicit `create_at`;
5. insert all file and image metadata rows;
6. build content from the resulting image IDs and update the article content;
7. insert `article_tag` and `article_source`;
8. update the candidate to `published` with `article_id`, guarded by
   `status = 'pending' AND article_id IS NULL`;
9. require exactly one affected candidate row and commit.

Return:

```js
return {
  articleId,
  images: imageRows,
  oldFilenames: [],
};
```

Rollback and release in the same pattern as `replacePublishedArticle`.

- [ ] **Step 8: Run repository tests and verify GREEN**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.richRepository.test.js
```

Expected: all repository tests pass with no warnings.

- [ ] **Step 9: Commit the repository behavior**

Run:

```bash
git add src/ingest/repositories/richArticleRepository.js test/tasks/contentIngest.richRepository.test.js
git commit -m "feat(ingest): 支持待处理候选事务发布"
```

### Task 2: Dispatch raw backfill to create or replace

**Files:**
- Modify: `src/ingest/pipeline/backfillRawArticles.js`
- Modify: `src/ingest/cli.js`
- Modify: `test/tasks/contentIngest.rawBackfill.test.js`
- Modify: `test/tasks/contentIngest.cli.test.js`

**Interfaces:**
- Consumes repository methods `listRawCandidatesByIds`,
  `replacePublishedArticle`, and `publishRawArticle`.
- Consumes pipeline option `tagName`.
- Produces `{ attempted, created, updated, failed, articles, failures }`.
- Each successful article includes
  `{ candidateId, articleId, operation, authorId, createAt, imageCount }`.

- [ ] **Step 1: Update existing test doubles and verify the old behavior is still explicit**

Change raw-backfill repository doubles from
`listPublishedCandidatesByIds` to `listRawCandidatesByIds`. Extend the existing
mapped replacement assertions:

```js
assert.equal(result.created, 0);
assert.equal(result.updated, 1);
assert.equal(result.articles[0].operation, 'updated');
```

Pass `tagName: '人工智能'` to every raw-backfill invocation.

- [ ] **Step 2: Write a failing pending-publication pipeline test**

Add:

```js
test('backfillRawArticles publishes an unmapped pending candidate without a model call', async () => {
  const writes = [];
  const pendingCandidate = {
    ...candidate,
    id: 3,
    articleId: null,
    status: 'pending',
    sourceId: 2,
    sourceName: 'OpenAI News',
    titleOriginal: 'Introducing the ChatGPT for small business program',
  };
  const repository = {
    async listRawCandidatesByIds(ids) {
      assert.deepEqual(ids, [3]);
      return [pendingCandidate];
    },
    async publishRawArticle(input) {
      writes.push(input);
      const images = input.assets.map((asset, index) => ({
        ...asset,
        id: 701 + index,
      }));
      return { articleId: 601, images, oldFilenames: [] };
    },
    async replacePublishedArticle() {
      throw new Error('pending candidate must not use replacement');
    },
  };

  const result = await backfillRawArticles({
    repository,
    ids: [3],
    authorIds: [2],
    tagName: '人工智能',
    now: new Date('2026-07-29T12:00:00.000Z'),
    days: 30,
    publicBaseURL: 'http://localhost:8000',
    outputDir: '/tmp/coderx-images',
    extractor: async () => sourcePageFor(pendingCandidate),
    localizeImages: fakeLocalizeImages,
    promoteAssets: fakePromoteAssets,
    deleteStoredFiles: async () => {},
  });

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.articles[0].articleId, 601);
  assert.equal(result.articles[0].operation, 'created');
  assert.equal(writes[0].candidateId, 3);
  assert.equal(writes[0].tagName, '人工智能');
});
```

Add a failure assertion proving promoted files are removed when
`publishRawArticle` rejects.

- [ ] **Step 3: Run raw pipeline tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 test/tasks/contentIngest.rawBackfill.test.js
```

Expected: the pending test fails because the pipeline still requires published
mappings and has no `created` result.

- [ ] **Step 4: Implement create-versus-replace dispatch**

Require the three repository methods and a non-empty `tagName`. Load candidates
with:

```js
const candidates = await repository.listRawCandidatesByIds(safeIds);
```

Keep the exact requested-ID count and distinct-source checks. Initialize:

```js
const result = {
  attempted: orderedCandidates.length,
  created: 0,
  updated: 0,
  failed: 0,
  articles: [],
  failures: [],
};
```

After promotion, build one common input:

```js
const writeInput = {
  candidateId: candidate.id,
  authorId,
  createAt,
  title: Array.from(page.title).slice(0, 50).join(''),
  excerpt,
  assets: promoted.assets,
  buildContent: (images) =>
    buildRawArticleContent({
      page,
      source: {
        name: candidate.sourceName,
        canonicalUrl: page.canonicalUrl || candidate.canonicalUrl,
        publishedAt: page.publishedAt || candidate.sourcePublishedAt,
      },
      images,
    }),
};
```

Dispatch:

```js
const isPending = candidate.status === 'pending' && candidate.articleId == null;
const persistence = isPending
  ? await repository.publishRawArticle({ ...writeInput, tagName })
  : await repository.replacePublishedArticle({
      ...writeInput,
      articleId: candidate.articleId,
    });
const operation = isPending ? 'created' : 'updated';
result[operation] += 1;
```

Use `persistence.articleId` in the output and retain current stale-file cleanup
for replacements. Pending publication returns an empty `oldFilenames` array.

- [ ] **Step 5: Pass `tagName` from the CLI composition**

In the `backfill-raw` action:

```js
return await backfillRawArticles({
  repository: richRepository,
  ids,
  authorIds: config.authorIds,
  tagName: config.tagName,
  days: options.days || 30,
  // existing options unchanged
});
```

Update the CLI test's fake return shape to include `created`, and add an
assertion that `backfill-raw` remains an explicit command outside `run`.

- [ ] **Step 6: Run focused pipeline and CLI tests**

Run:

```bash
node --test --test-concurrency=1 \
  test/tasks/contentIngest.rawBackfill.test.js \
  test/tasks/contentIngest.richRepository.test.js \
  test/tasks/contentIngest.cli.test.js
```

Expected: all focused tests pass with no model calls.

- [ ] **Step 7: Commit the pipeline behavior**

Run:

```bash
git add src/ingest/pipeline/backfillRawArticles.js src/ingest/cli.js \
  test/tasks/contentIngest.rawBackfill.test.js test/tasks/contentIngest.cli.test.js
git commit -m "feat(ingest): 允许原文回填直接新增文章"
```

### Task 3: Document, verify, and publish the first new local batch

**Files:**
- Modify: `README.md`
- Modify in frontend repository:
  `/Users/yangdanping/Desktop/personal_project/coderx/.cursor/skills/coderx-raw-content-ops/SKILL.md`
- Runtime output only: local PostgreSQL database and the two local
  `public/img` directories.

**Interfaces:**
- Operational command:
  `pnpm ingest backfill-raw --ids 72,3,35,23,55 --limit 5`.
- Verification input: the five newly returned article IDs.

- [ ] **Step 1: Update operational documentation**

Change the README data flow to:

```text
公开 RSS/Atom → 规范化/评分/去重 → ingest_candidate
                                      ↓
                             显式 backfill-raw IDs
                                      ↓
              pending: 原文发布 / published: 原文回填
```

Document that:

- pending candidates are published directly with the existing configured tag;
- published candidates are replaced in place;
- only explicit IDs are accepted;
- both routes remain model-free and bounded to five.

Update the project skill:

- replace “every requested candidate is already mapped” with eligibility for
  either unmapped `pending` or mapped `published`;
- require unique canonical URLs, distinct sources, existing authors, and the
  `人工智能` tag;
- define finish counts as `created / updated / failed`.

- [ ] **Step 2: Run all ingest tests**

Run:

```bash
node --test --test-concurrency=1 "test/tasks/contentIngest.*.test.js"
```

Expected: all ingest tests pass.

- [ ] **Step 3: Run the full backend suite once**

Load the existing local `.env.development` without printing secrets, then run:

```bash
node --test --test-concurrency=1 \
  "test/service/*.test.js" \
  "test/tasks/*.test.js" \
  "test/controller/*.test.js"
```

Expected: all backend tests pass.

- [ ] **Step 4: Commit documentation**

In the backend worktree:

```bash
git add README.md
git commit -m "docs(ingest): 说明待处理候选原文发布流程"
```

In the frontend repository, stage only the skill file, preserving all unrelated
dirty frontend files:

```bash
git add .cursor/skills/coderx-raw-content-ops/SKILL.md
git commit -m "docs(ingest): 更新原文采集批次规则"
```

- [ ] **Step 5: Re-run the read-only preflight and confirm the exact batch**

Confirm:

- candidates `72,3,35,23,55` are still `pending` and unmapped;
- their canonical URLs and source names are distinct;
- their source dates are within 30 days;
- users `1,2,3,4,5` are active and have avatars;
- tag `人工智能` exists;
- the local API working directory and ingest asset directory are known.

- [ ] **Step 6: Publish the new local batch**

From the ingest worktree, with credentials loaded from the existing local
environment without printing them:

```bash
INGEST_AUTHOR_IDS=1,2,3,4,5 \
INGEST_TAG_NAME=人工智能 \
PUBLIC_API_ORIGIN=http://192.168.3.96:8000 \
pnpm ingest backfill-raw --ids 72,3,35,23,55 --limit 5
```

Expected:

```json
{
  "attempted": 5,
  "created": 5,
  "updated": 0,
  "failed": 0
}
```

Do not retry a failed source. Record its candidate ID and exact failure while
allowing other candidates to finish.

- [ ] **Step 7: Reconcile only the new batch assets**

Read the exact filenames linked to the five new article IDs. Compare each
original and `-small` file between the ingest worktree and the active API
working directory:

- copy only files missing from the API directory;
- accept byte-identical existing files;
- stop without overwriting if a same-name file differs.

- [ ] **Step 8: Verify database, API, assets, and visible list**

Run `verify-local.sh` with the five new article IDs and an API process that
matches the verified code and assets. It must report:

```text
articles=5 authors=5 structured=5 recent=5
images=<at-least-5> checked_image_urls=<twice-image-count>
placeholders=0
verification=ok
```

Additionally call the local article-list endpoint and assert that all five new
IDs are present in the latest `人工智能` results. If the active port 8000 API is
blocked by unrelated uncommitted schema work, use a temporary API from the
clean ingest worktree on an unused port, verify, and stop it afterward without
changing the unrelated migration.

- [ ] **Step 9: Final clean-state check**

Confirm:

- backend worktree branch is `codex/ai-content-ingest` and clean;
- any frontend changes remaining are the user's pre-existing unrelated work;
- no temporary API is listening;
- production was untouched;
- final report includes created, updated, failed, candidate IDs, article IDs,
  image count, verification result, and branches.
