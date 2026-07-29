# Raw Article Ingest and Placeholder Cleanup Design

## Goal

Change the AI-content supply path from model-generated Chinese summaries to editable source-language articles. The service will fetch a public source page, retain its readable headings and paragraphs, download related images into CoderX storage, and write a normal Tiptap document that the user can translate manually.

The same change will remove the low-value placeholder articles whose entire body follows the fixed `摘要 / 为什么值得阅读 / 来源 / 阅读原文` template.

## Chosen approach

Use structured readable extraction, not source HTML embedding.

- Keep the source title, readable headings, paragraphs, author, publication time, and canonical URL.
- Strip scripts, styles, navigation, cookie banners, and other page chrome.
- Convert readable content into the existing Tiptap JSON contract.
- Download up to three useful source images, create local JPEG thumbnails, and insert the images between article sections.
- Preserve a visible source disclosure and original link.
- Do not call Ollama or any translation model in the raw ingest path.

This keeps articles editable in the existing frontend while avoiding unsafe third-party HTML and CSS.

## Components and data flow

1. `safeRemoteFetch` validates that every page and image URL resolves to the public internet.
2. `extractArticlePage` produces normalized source metadata, sections, paragraphs, and image candidates.
3. `localizeArticleImages` uses Sharp so PNG, JPEG, WebP, GIF, and AVIF responses can be decoded and converted into the existing local JPEG contract.
4. `buildRawArticleContent` maps extracted sections and localized image IDs into Tiptap JSON without translation or synthetic prose.
5. `backfillRawArticles` assigns existing users and dates, then replaces each mapped article inside the existing per-article database transaction.
6. The CLI exposes an explicit `backfill-raw` command. This becomes the documented operational command for future content batches; the model-backed rich rewrite remains available only as a non-default legacy command.

## Placeholder cleanup

The cleanup target is structural, not title- or date-based. An article matches only when its Tiptap document contains all four exact markers:

- heading `摘要`
- heading `为什么值得阅读`
- heading `来源`
- linked text `阅读原文 ↗`

The current local database contains six matches: article IDs `144, 145, 147, 148, 149, 150`.

Article `150` is the pending GitHub item. It will first be replaced in place by raw source content, so it will no longer match. The remaining five placeholder articles will then be deleted in one transaction, with their ingest candidates marked `rejected` and annotated so the scheduler cannot immediately recreate them.

Before applying deletion, the command will emit a JSON manifest containing the exact article ID, candidate ID, title, canonical URL, and full Tiptap content. Cleanup requires an explicit apply flag and performs no production action.

## Failure handling

- A page without enough readable source text is rejected without changing the current article.
- A batch with no usable image is rejected without changing the current article.
- Image files are staged in a temporary directory and promoted only after the article transaction is ready.
- Database failure removes newly staged files.
- Cleanup rechecks the exact placeholder signature inside its transaction before deleting anything.

## Verification

- Unit tests cover raw Tiptap mapping, image placement, source disclosure, WebP conversion, and the exact placeholder predicate.
- Integration tests cover raw replacement and cleanup transaction behavior.
- Live verification checks the GitHub article through PostgreSQL and the local article API, confirms local image responses, then confirms that no placeholder-signature articles remain.
- Existing ingest and application tests must pass.
- Work stops before any production deployment or remote database synchronization.
