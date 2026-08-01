function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectLegacyMediaNodes(node, articleId, issues) {
  if (!isPlainObject(node)) return;
  const attrs = isPlainObject(node.attrs) ? node.attrs : {};
  if (node.type === 'image' && !positiveId(attrs.imageId ?? attrs.imgId)) {
    issues.push({ articleId, nodeType: 'image' });
  } else if (node.type === 'video' && !positiveId(attrs.videoId)) {
    issues.push({ articleId, nodeType: 'video' });
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectLegacyMediaNodes(child, articleId, issues);
  }
}

async function inventoryMedia({ catalog, database, articleId, afterFileId = 0, limit = 1_000 } = {}) {
  if (!catalog || typeof catalog.listPublishedFiles !== 'function') throw new TypeError('catalog is required');
  if (!database || typeof database.execute !== 'function') throw new TypeError('database is required');
  const files = await catalog.listPublishedFiles({ articleId, afterFileId, limit });
  const discovered = await catalog.discoverVariants(files);
  const filesystemCoverageComplete = articleId == null && Number(afterFileId || 0) === 0 && files.length < Number(limit);
  const filesystemFiles = filesystemCoverageComplete ? await catalog.listFilesystemFiles() : [];
  const expectedPaths = catalog.expectedPaths(files);
  const [articles] = await database.execute(
    `
      SELECT id, content
      FROM article
      WHERE content IS NOT NULL
        ${articleId == null ? '' : 'AND id = ?'}
      ORDER BY id ASC;
    `,
    articleId == null ? [] : [Number(articleId)],
  );
  const legacyContentWithoutStableMediaId = [];
  for (const article of articles) {
    collectLegacyMediaNodes(article.content, Number(article.id), legacyContentWithoutStableMediaId);
  }
  return {
    snapshotAt: new Date().toISOString(),
    scope: 'published',
    published: {
      logicalFiles: files.length,
      physicalObjects: discovered.candidates.length,
      bytes: discovered.candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    },
    missingPhysicalFiles: discovered.missingAssets,
    optionalMissingAssets: discovered.optionalMissingAssets,
    invalidRows: discovered.invalidRows,
    filesystemCoverageComplete,
    filesystemFilesWithoutDatabase: filesystemFiles.filter((filePath) => !expectedPaths.has(filePath)),
    legacyContentWithoutStableMediaId,
    nextAfterFileId: files.length > 0 ? files.at(-1).id : Number(afterFileId || 0),
  };
}

module.exports = {
  collectLegacyMediaNodes,
  inventoryMedia,
};
