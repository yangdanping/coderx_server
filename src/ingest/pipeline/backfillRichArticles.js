const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assignAuthors, assignBackfillDates } = require('@/ingest/domain/assignBackfillMetadata');
const { buildRichArticleContent } = require('@/ingest/domain/buildRichArticleContent');
const { smallFilename } = require('@/ingest/media/localizeArticleImages');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function publicImageUrl(baseURL, filename) {
  return `${String(baseURL).replace(/\/+$/, '')}/article/images/${encodeURIComponent(filename)}`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function promoteArticleAssets(assets, { outputDir, publicBaseURL }) {
  await fs.mkdir(outputDir, { recursive: true });
  const copiedPaths = [];
  const promotedAssets = [];

  for (const asset of assets) {
    const fullDestination = path.resolve(outputDir, asset.filename);
    const smallDestination = path.resolve(outputDir, asset.smallFilename);
    if (!(await pathExists(fullDestination))) {
      await fs.copyFile(asset.temporaryPath, fullDestination);
      copiedPaths.push(fullDestination);
    }
    if (!(await pathExists(smallDestination))) {
      await fs.copyFile(asset.smallTemporaryPath, smallDestination);
      copiedPaths.push(smallDestination);
    }
    promotedAssets.push({
      ...asset,
      src: publicImageUrl(publicBaseURL, asset.filename),
    });
  }
  return { assets: promotedAssets, copiedPaths };
}

async function removeArticleFiles(files, { outputDir }) {
  const paths = [];
  for (const file of files || []) {
    if (path.isAbsolute(file)) {
      paths.push(file);
      continue;
    }
    paths.push(path.resolve(outputDir, file), path.resolve(outputDir, smallFilename(file)));
  }
  await Promise.all([...new Set(paths)].map((filePath) => fs.rm(filePath, { force: true })));
}

async function backfillRichArticles({
  repository,
  extractor,
  enricher,
  localizeImages,
  authorIds,
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
    throw new Error('backfill-rich requires 1–5 unique positive candidate IDs');
  }
  if (!Array.isArray(authorIds) || authorIds.length < safeIds.length) {
    throw new Error('Rich backfill requires one approved existing author per article');
  }
  if (!repository || typeof repository.listPublishedCandidatesByIds !== 'function' || typeof repository.replacePublishedArticle !== 'function') {
    throw new Error('rich article repository is required');
  }
  if (typeof extractor !== 'function' || !enricher?.enrich || typeof localizeImages !== 'function') {
    throw new Error('extractor, enricher and localizeImages are required');
  }
  if (!outputDir || !publicBaseURL) throw new Error('outputDir and publicBaseURL are required');

  const candidates = await repository.listPublishedCandidatesByIds(safeIds);
  if (candidates.length !== safeIds.length) {
    throw new Error(`Expected ${safeIds.length} mapped published candidates; found ${candidates.length}`);
  }
  if (new Set(candidates.map((candidate) => candidate.sourceName)).size !== candidates.length) {
    throw new Error('Rich backfill requires one distinct source per article');
  }

  const authorAssignments = assignAuthors(candidates, authorIds);
  const dateAssignments = assignBackfillDates(candidates, { now, days });
  const orderedCandidates = safeIds.map((id) => candidates.find((candidate) => candidate.id === id));
  const result = {
    attempted: orderedCandidates.length,
    updated: 0,
    failed: 0,
    articles: [],
    failures: [],
  };

  for (const candidate of orderedCandidates) {
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), `coderx-rich-${candidate.id}-`));
    let localized = null;
    let promoted = null;
    try {
      const page = await extractor(candidate);
      const article = await enricher.enrich(page, candidate);
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
      const replacement = await repository.replacePublishedArticle({
        articleId: candidate.articleId,
        candidateId: candidate.id,
        authorId,
        createAt,
        title: Array.from(article.titleZh).slice(0, 50).join(''),
        excerpt: article.lead,
        assets: promoted.assets,
        buildContent: (images) =>
          buildRichArticleContent({
            article,
            source: {
              name: candidate.sourceName,
              canonicalUrl: candidate.canonicalUrl,
              publishedAt: candidate.sourcePublishedAt,
            },
            images,
          }),
      });
      const currentFilenames = new Set(promoted.assets.map((asset) => asset.filename));
      await deleteStoredFiles(
        replacement.oldFilenames.filter((filename) => !currentFilenames.has(filename)),
        { outputDir },
      );
      result.updated += 1;
      result.articles.push({
        candidateId: candidate.id,
        articleId: candidate.articleId,
        authorId,
        createAt,
        imageCount: replacement.images.length,
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
  backfillRichArticles,
  promoteArticleAssets,
  removeArticleFiles,
};
