const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assignAuthors, assignBackfillDates } = require('@/ingest/domain/assignBackfillMetadata');
const { buildRichArticleContent } = require('@/ingest/domain/buildRichArticleContent');
const { smallFilename } = require('@/ingest/media/localizeArticleImages');
const { inspectLocalFile } = require('@/service/mediaPromotion.service');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function publicImageUrl(baseURL, filename) {
  return `${String(baseURL).replace(/\/+$/, '')}/article/images/${encodeURIComponent(filename)}`;
}

async function promoteArticleAssets(assets, { outputDir, publicBaseURL }) {
  await fs.mkdir(outputDir, { recursive: true });
  const copiedPaths = [];
  const promotedAssets = [];
  async function copyImmutable(source, filename) {
    if (!filename || filename !== path.basename(filename) || filename.includes('\\')) throw new Error('image filename must not contain a path');
    const destination = path.resolve(outputDir, filename);
    const inspected = await inspectLocalFile(source);
    try {
      await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
      copiedPaths.push(destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stats = await fs.lstat(destination);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Ingest image ${filename} is not a regular immutable file`);
    }
    const existing = await inspectLocalFile(destination);
    if (existing.sizeBytes !== inspected.sizeBytes || existing.sha256 !== inspected.sha256) {
      throw new Error(`Ingest image ${filename} contains different immutable content`);
    }
    return inspected;
  }
  try {
    for (const asset of assets) {
      const original = await copyImmutable(asset.temporaryPath, asset.filename);
      await copyImmutable(asset.smallTemporaryPath, asset.smallFilename);
      promotedAssets.push({ ...asset, sha256: original.sha256, src: publicImageUrl(publicBaseURL, asset.filename) });
    }
    return { assets: promotedAssets, copiedPaths };
  } catch (error) {
    await Promise.all(copiedPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }
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

// Persistence and media synchronization have separate outcomes. A postcommit error
// must never enter the compensation path for newly copied published files.
async function synchronizeCommittedMedia({ persistence, promoted, synchronizeMedia, deleteStoredFiles, outputDir }) {
  try {
    if (!persistence.mediaCleanupManaged) {
      const currentFilenames = new Set(promoted.assets.map((asset) => asset.filename));
      await deleteStoredFiles(
        (persistence.oldFilenames || []).filter((filename) => !currentFilenames.has(filename)),
        { outputDir },
      );
    }
    if (typeof synchronizeMedia !== 'function') {
      return { status: 'retry_required', reason: 'media_synchronization_unavailable' };
    }
    return await synchronizeMedia({ articleId: persistence.articleId });
  } catch (error) {
    return { status: 'retry_required', reason: errorMessage(error) };
  }
}

async function cleanupTemporaryAssets(localized, temporaryDir) {
  const warnings = [];
  try {
    if (localized?.cleanup) await localized.cleanup();
  } catch (error) {
    warnings.push(errorMessage(error));
  }
  try {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  } catch (error) {
    warnings.push(errorMessage(error));
  }
  return warnings;
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
  synchronizeMedia,
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
      const media = await synchronizeCommittedMedia({ persistence: replacement, promoted, synchronizeMedia, deleteStoredFiles, outputDir });
      result.updated += 1;
      result.articles.push({
        candidateId: candidate.id,
        articleId: candidate.articleId,
        authorId,
        createAt,
        imageCount: replacement.images.length,
        media,
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
      const warnings = await cleanupTemporaryAssets(localized, temporaryDir);
      const outcome = result.articles.find((article) => article.candidateId === candidate.id) || result.failures.find((entry) => entry.candidateId === candidate.id);
      if (warnings.length && outcome) outcome.cleanupWarnings = warnings;
    }
  }
  return result;
}

module.exports = {
  backfillRichArticles,
  promoteArticleAssets,
  removeArticleFiles,
  synchronizeCommittedMedia,
  cleanupTemporaryAssets,
};
