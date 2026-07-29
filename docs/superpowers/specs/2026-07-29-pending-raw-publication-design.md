# Pending Raw Article Publication Design

## Goal

Allow the existing `backfill-raw` command to publish a bounded batch of
unmapped `pending` ingest candidates as new CoderX articles. The command must
continue to refresh already-published candidates, while preserving the
model-free English-source workflow, local images, existing users, and the
`人工智能` tag.

The first local batch will contain five distinct sources:

- candidate `72`: AWS Machine Learning Blog
- candidate `3`: OpenAI News
- candidate `35`: Hugging Face Blog
- candidate `23`: NVIDIA Generative AI
- candidate `55`: GitHub AI & ML

## Chosen approach

Extend `backfill-raw` instead of adding a second operational command.

- A mapped `published` candidate follows the current replacement path.
- An unmapped `pending` candidate follows a new transactional publication
  path.
- Any other state, partial mapping, duplicate canonical URL, missing author, or
  missing `人工智能` tag is rejected before article publication.
- The command remains limited to five unique candidate IDs and one distinct
  source per article.

This keeps the project skill accurate: operators still use one bounded
`backfill-raw` mutation and one verification pass. It also avoids the legacy
`enrich → approve → publish` route, which would invoke a model and create
temporary rewritten content.

## Components and responsibilities

### Candidate repository

Replace the published-only lookup with a raw-publication lookup that returns
both:

- mapped candidates whose status is `published`; and
- unmapped candidates whose status is `pending`.

The repository validates that every requested ID is eligible and exposes
whether each candidate is a replacement or a new publication.

### Raw backfill pipeline

The pipeline keeps the current extraction, image localization, author
assignment, date assignment, Tiptap building, and per-candidate failure
isolation.

After source extraction and asset staging:

- mapped candidates call `replacePublishedArticle`;
- pending candidates call `publishRawArticle`.

Both paths return the resulting article ID and image count in the same result
shape. The batch summary distinguishes `created`, `updated`, and `failed`
counts so operators can tell whether new articles were actually added.

### Transactional raw publication

`publishRawArticle` performs one database transaction:

1. lock and recheck the pending candidate;
2. resolve the existing `人工智能` tag;
3. reject a canonical URL already mapped to another article;
4. insert the article with the assigned existing user, source title, excerpt,
   Tiptap JSON, and assigned recent date;
5. insert `article_tag`, `article_source`, `file`, and `image_meta` rows;
6. update the candidate to `published` with its new `article_id`;
7. commit.

Source images are promoted before the transaction, matching the current
replacement path. A database failure removes only the newly promoted files.

## Data and content constraints

- Preserve the source-language title, headings, paragraphs, byline,
  publication time, canonical URL, and useful images.
- Do not translate, rewrite, summarize, call Ollama, or change VPN state.
- Use existing active author IDs `1,2,3,4,5`; never create users.
- Require one distinct author and one distinct source per article in a
  five-item batch.
- Store editable Tiptap JSON and one to three local JPEG images with
  thumbnails.
- Operate only on the local PostgreSQL database and local asset directories.
- Do not deploy, enable a production worker, or mutate a remote database.

## Failure handling

- Source extraction or image validation failure leaves the candidate pending
  and creates no article.
- A transaction failure rolls back article, source, tag, and file metadata and
  removes newly promoted files.
- A candidate that changes status or gains a mapping after selection fails its
  locked recheck.
- A single candidate failure is recorded in the batch result without retrying
  it or rolling back successful candidates.
- Existing mapped articles retain their current replacement guarantees.

## Verification

Automated tests must prove:

- pending and published candidates are both selected, while invalid states and
  partial mappings are rejected;
- pending publication inserts all related rows and updates the candidate in
  one transaction;
- rollback occurs on any publication failure;
- the pipeline chooses create versus replace correctly and reports accurate
  counts;
- no model-backed enricher is constructed or called;
- existing raw replacement behavior remains unchanged.

The local batch verification must confirm:

- five new article IDs exist for candidates `72,3,35,23,55`;
- all five articles use different existing authors and dates within 30 days;
- all articles contain structured source-language content;
- every article has at least one linked image;
- every original and thumbnail URL returns HTTP 200;
- no fixed-format placeholder article remains;
- the articles appear in the local article list;
- the ingest worktree is clean and production is untouched.
