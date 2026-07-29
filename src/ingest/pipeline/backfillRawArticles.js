const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assignAuthors, assignBackfillDates } = require('@/ingest/domain/assignBackfillMetadata');
const { buildRawArticleContent, rawArticleExcerpt } = require('@/ingest/domain/buildRawArticleContent');
const { promoteArticleAssets, removeArticleFiles } = require('@/ingest/pipeline/backfillRichArticles');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function backfillRawArticles({
  repository,
  extractor,
  localizeImages,
  authorIds,
  tagName,
  ids,
  now = new Date(),
  days = 30,
  outputDir,
  publicBaseURL,
  promoteAssets = promoteArticleAssets,
  deleteStoredFiles = removeArticleFiles,
}) {
  const safeIds = Array.isArray(ids) ? ids.map(Number) : [];
  if (safeIds.length === 0 || safeIds.length > 5 || safeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(safeIds).size !== safeIds.length) {
    throw new Error('backfill-raw requires 1–5 unique positive candidate IDs');
  }
  if (!Array.isArray(authorIds) || authorIds.length < safeIds.length) {
    throw new Error('Raw backfill requires one approved existing author per article');
  }
  const safeAuthorIds = authorIds.map(Number);
  if (safeAuthorIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(safeAuthorIds).size !== safeAuthorIds.length) {
    throw new Error('Raw backfill author IDs must be unique positive integers');
  }
  if (
    !repository ||
    typeof repository.listRawCandidatesByIds !== 'function' ||
    typeof repository.publishRawArticle !== 'function' ||
    typeof repository.replacePublishedArticle !== 'function'
  ) {
    throw new Error('raw article repository is required');
  }
  if (typeof extractor !== 'function' || typeof localizeImages !== 'function') {
    throw new Error('extractor and localizeImages are required');
  }
  if (!String(tagName || '').trim()) throw new Error('tagName is required');
  if (!outputDir || !publicBaseURL) throw new Error('outputDir and publicBaseURL are required');

  const candidates = await repository.listRawCandidatesByIds(safeIds);
  if (candidates.length !== safeIds.length) {
    throw new Error(`Expected ${safeIds.length} eligible raw candidates; found ${candidates.length}`);
  }
  if (new Set(candidates.map((candidate) => candidate.sourceName)).size !== candidates.length) {
    throw new Error('Raw backfill requires one distinct source per article');
  }

  const authorAssignments = candidates.length === 1 ? new Map([[candidates[0].id, safeAuthorIds[0]]]) : assignAuthors(candidates, safeAuthorIds);
  const dateAssignments = assignBackfillDates(candidates, { now, days });
  const orderedCandidates = safeIds.map((id) => candidates.find((candidate) => candidate.id === id));
  const result = {
    attempted: orderedCandidates.length,
    created: 0,
    updated: 0,
    failed: 0,
    articles: [],
    failures: [],
  };

  for (const candidate of orderedCandidates) {
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), `coderx-raw-${candidate.id}-`));
    let localized = null;
    let promoted = null;
    try {
      const page = await extractor(candidate);
      const excerpt = rawArticleExcerpt(page);
      if (!excerpt) throw new Error('Source article has no usable excerpt');
      localized = await localizeImages({
        candidateId: candidate.id,
        images: page.images,
        outputDir: temporaryDir,
      });
      promoted = await promoteAssets(localized.assets, {
        outputDir,
        publicBaseURL,
      });
      const authorId = authorAssignments.get(candidate.id);
      const createAt = dateAssignments.get(candidate.id);
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
      const isPending = candidate.status === 'pending' && candidate.articleId == null;
      const persistence = isPending
        ? await repository.publishRawArticle({
            ...writeInput,
            tagName,
          })
        : await repository.replacePublishedArticle({
            ...writeInput,
            articleId: candidate.articleId,
          });
      const currentFilenames = new Set(promoted.assets.map((asset) => asset.filename));
      await deleteStoredFiles(
        persistence.oldFilenames.filter((filename) => !currentFilenames.has(filename)),
        { outputDir },
      );
      const operation = isPending ? 'created' : 'updated';
      result[operation] += 1;
      result.articles.push({
        candidateId: candidate.id,
        articleId: persistence.articleId,
        operation,
        authorId,
        createAt,
        imageCount: persistence.images.length,
      });
    } catch (error) {
      if (promoted?.copiedPaths?.length) {
        await deleteStoredFiles(promoted.copiedPaths, { outputDir });
      }
      result.failed += 1;
      result.failures.push({
        candidateId: candidate.id,
        reason: errorMessage(error),
      });
    } finally {
      if (localized?.cleanup) await localized.cleanup();
      await fs.rm(temporaryDir, { recursive: true, force: true });
    }
  }

  return result;
}

module.exports = {
  backfillRawArticles,
};
