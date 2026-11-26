import { constants } from 'node:fs';
import type { DatabaseTransaction } from '../../app/database/database.types.js';
import type { RichArticle } from '../enrichment/createRichArticleEnricher.js';
import type { DatabaseId, ExtractedArticle } from '../ingest.types.js';
import type { localizeArticleImages, LocalizedAsset } from '../media/localizeArticleImages.js';
import type { PublishedCandidate, RichArticleRepository } from '../repositories/richArticleRepository.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assignAuthors, assignBackfillDates } from '../domain/assignBackfillMetadata.js';
import { buildRichArticleContent } from '../domain/buildRichArticleContent.js';
import { smallFilename } from '../media/localizeArticleImages.js';
import { inspectLocalFile } from '../../service/mediaPromotion.service.js';

type AssetLocation = { outputDir: string; publicBaseURL: string };
type PromotedAsset = LocalizedAsset & { sha256: string; src: string };
type PromotedAssets = { assets: PromotedAsset[]; copiedPaths: string[] };
type LifecycleRepository = Partial<Pick<RichArticleRepository, 'withMediaLifecycleLock'>>;

interface PersistedArticle {
  articleId: DatabaseId;
  images: readonly unknown[];
  oldFilenames?: readonly string[];
  mediaCleanupManaged?: boolean;
}

export interface MediaSynchronization {
  status: 'retry_required' | 'ready' | 'local_ready';
  reason?: string | null;
}

export interface BackfillOptions<Candidate> extends AssetLocation {
  extractor(candidate: Candidate): Promise<ExtractedArticle>;
  localizeImages: typeof localizeArticleImages;
  authorIds: readonly number[];
  ids: readonly number[];
  now?: Date;
  days?: number;
  promoteAssets?: typeof promoteArticleAssets;
  deleteStoredFiles?: typeof removeArticleFiles;
  synchronizeMedia?: (payload: { articleId: DatabaseId }) => Promise<MediaSynchronization>;
}

export interface BackfillArticle {
  candidateId: number;
  articleId: DatabaseId;
  authorId: number;
  createAt: Date;
  imageCount: number;
  media: MediaSynchronization;
  cleanupWarnings?: string[];
}

export interface BackfillFailure {
  candidateId: number;
  reason: string;
  cleanupWarnings?: string[];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function publicImageUrl(baseURL: string, filename: string) {
  return `${String(baseURL).replace(/\/+$/, '')}/article/images/${encodeURIComponent(filename)}`;
}

async function promoteArticleAssets(assets: readonly LocalizedAsset[], { outputDir, publicBaseURL }: AssetLocation): Promise<PromotedAssets> {
  await fs.mkdir(outputDir, { recursive: true });
  const copiedPaths: string[] = [];
  const promotedAssets = [];
  async function copyImmutable(source: string, filename: string) {
    if (!filename || filename !== path.basename(filename) || filename.includes('\\')) throw new Error('image filename must not contain a path');
    const destination = path.resolve(outputDir, filename);
    const inspected = await inspectLocalFile(source);
    try {
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      copiedPaths.push(destination);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
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

async function removeArticleFiles(files: readonly string[], { outputDir }: Pick<AssetLocation, 'outputDir'>) {
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

// Public copy, database commit/rollback and precommit compensation share the
// candidate lock used by generic cleanup, including calls outside the CLI.
async function persistArticleAssets<WriteResult extends PersistedArticle>({
  repository,
  candidateId,
  assets,
  outputDir,
  publicBaseURL,
  promoteAssets,
  deleteStoredFiles,
  writeArticle,
}: AssetLocation & {
  repository: LifecycleRepository;
  candidateId: number;
  assets: readonly LocalizedAsset[];
  promoteAssets: typeof promoteArticleAssets;
  deleteStoredFiles: typeof removeArticleFiles;
  writeArticle(assets: PromotedAsset[], mediaConnection?: DatabaseTransaction): Promise<WriteResult>;
}) {
  async function copyAndPersist(mediaConnection?: DatabaseTransaction) {
    let promoted: PromotedAssets | undefined;
    try {
      promoted = await promoteAssets(assets, { outputDir, publicBaseURL });
      const persistence = await writeArticle(promoted.assets, mediaConnection);
      return { promoted, persistence };
    } catch (error) {
      if (promoted?.copiedPaths?.length) await deleteStoredFiles(promoted.copiedPaths, { outputDir });
      throw error;
    }
  }
  return typeof repository.withMediaLifecycleLock === 'function' ? repository.withMediaLifecycleLock(candidateId, copyAndPersist) : copyAndPersist();
}

// Persistence and media synchronization have separate outcomes. A postcommit error
// must never enter the compensation path for newly copied published files.
async function synchronizeCommittedMedia({
  persistence,
  promoted,
  synchronizeMedia,
  deleteStoredFiles,
  outputDir,
}: {
  persistence: PersistedArticle;
  promoted: PromotedAssets;
  synchronizeMedia: BackfillOptions<unknown>['synchronizeMedia'];
  deleteStoredFiles: typeof removeArticleFiles;
  outputDir: string;
}): Promise<MediaSynchronization> {
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

async function cleanupTemporaryAssets(localized: { cleanup?: () => Promise<void> } | null, temporaryDir: string) {
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
}: BackfillOptions<PublishedCandidate> & {
  repository: Pick<RichArticleRepository, 'listPublishedCandidatesByIds' | 'replacePublishedArticle'> & LifecycleRepository;
  enricher: { enrich(page: ExtractedArticle, candidate: PublishedCandidate): Promise<RichArticle> };
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
  const orderedCandidates = safeIds.map((id) => candidates.find((candidate) => candidate.id === id)!);
  const result = {
    attempted: orderedCandidates.length,
    updated: 0,
    failed: 0,
    articles: [] as BackfillArticle[],
    failures: [] as BackfillFailure[],
  };

  for (const candidate of orderedCandidates) {
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), `coderx-rich-${candidate.id}-`));
    let localized: Awaited<ReturnType<typeof localizeArticleImages>> | null = null;
    try {
      const page = await extractor(candidate);
      const article = await enricher.enrich(page, candidate);
      localized = await localizeImages({
        candidateId: candidate.id,
        images: page.images,
        outputDir: temporaryDir,
      });
      const authorId = authorAssignments.get(candidate.id)!;
      const createAt = dateAssignments.get(candidate.id)!;
      const { persistence: replacement, promoted: copied } = await persistArticleAssets({
        repository,
        candidateId: candidate.id,
        assets: localized.assets,
        outputDir,
        publicBaseURL,
        promoteAssets,
        deleteStoredFiles,
        writeArticle: (assets, mediaConnection) =>
          repository.replacePublishedArticle({
            articleId: candidate.articleId,
            candidateId: candidate.id,
            authorId,
            createAt,
            title: Array.from(article.titleZh).slice(0, 50).join(''),
            excerpt: article.lead,
            assets,
            mediaConnection,
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
          }),
      });
      const media = await synchronizeCommittedMedia({ persistence: replacement, promoted: copied, synchronizeMedia, deleteStoredFiles, outputDir });
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

export { backfillRichArticles, promoteArticleAssets, removeArticleFiles, synchronizeCommittedMedia, cleanupTemporaryAssets, persistArticleAssets };
