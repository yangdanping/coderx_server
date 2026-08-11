const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('module-alias/register');

const { createMediaCatalog } = require('@/tasks/mediaCatalog');
const { inventoryMedia } = require('@/tasks/inventoryMedia');

async function fixtureRoots(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-media-inventory-'));
  const imageRoot = path.join(root, 'img');
  const videoRoot = path.join(root, 'video');
  await fs.mkdir(imageRoot);
  await fs.mkdir(videoRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { imageRoot, videoRoot };
}

function databaseWithRows(files, articles = []) {
  const calls = [];
  return {
    calls,
    async execute(statement, params) {
      calls.push({ statement, params });
      if (/FROM file f/i.test(statement)) return [files, []];
      if (/FROM article/i.test(statement)) return [articles, []];
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  };
}

test('media catalog lists published files in deterministic batches and discovers physical variants', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'cover.jpg'), 'original');
  await fs.writeFile(path.join(imageRoot, 'cover-small.jpg'), 'small');
  await fs.writeFile(path.join(imageRoot, 'solo.png'), 'solo');
  await fs.writeFile(path.join(videoRoot, 'clip.mp4'), 'video');
  await fs.writeFile(path.join(videoRoot, 'clip-poster.jpg'), 'poster');
  const rows = [
    { id: 11, articleId: 7, filename: 'cover.jpg', mimetype: 'image/jpeg', fileType: 'image' },
    { id: 12, articleId: 7, filename: 'solo.png', mimetype: 'image/png', fileType: 'image' },
    {
      id: 13,
      articleId: 8,
      filename: 'clip.mp4',
      mimetype: 'video/mp4',
      fileType: 'video',
      poster: 'clip-poster.jpg',
      transcodeStatus: 'completed',
    },
  ];
  const database = databaseWithRows(rows);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  const selected = await catalog.listPublishedFiles({ articleId: 7, afterFileId: 10, limit: 3 });
  const discovered = await catalog.discoverVariants(selected);

  assert.deepEqual(database.calls[0].params, [10, 7, 3]);
  assert.match(database.calls[0].statement, /f\.article_id IS NOT NULL/i);
  assert.match(database.calls[0].statement, /f\.id > \?/i);
  assert.match(database.calls[0].statement, /ORDER BY f\.id ASC[\s\S]*LIMIT \?/i);
  assert.deepEqual(
    discovered.candidates.map((candidate) => [candidate.fileId, candidate.variant, candidate.sizeBytes]),
    [
      [11, 'original', 8],
      [11, 'small', 5],
      [12, 'original', 4],
      [13, 'video', 5],
      [13, 'poster', 6],
    ],
  );
  assert.deepEqual(discovered.optionalMissingAssets, [{ fileId: 12, articleId: 7, variant: 'small' }]);
  assert.deepEqual(discovered.missingAssets, []);
  assert.deepEqual(discovered.invalidRows, []);
});

test('media catalog rejects unsafe filenames and reports required missing assets without producing candidates', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  const catalog = createMediaCatalog({ database: databaseWithRows([]), imageRoot, videoRoot });

  const result = await catalog.discoverVariants([
    { id: 21, articleId: 9, filename: '../secret.jpg', mimetype: 'image/jpeg', fileType: 'image' },
    {
      id: 22,
      articleId: 9,
      filename: 'missing.mp4',
      mimetype: 'video/mp4',
      fileType: 'video',
      poster: 'missing-poster.jpg',
      transcodeStatus: 'completed',
    },
    {
      id: 23,
      articleId: 9,
      filename: 'pending.mp4',
      mimetype: 'video/mp4',
      fileType: 'video',
      poster: 'pending-poster.jpg',
      transcodeStatus: 'processing',
    },
  ]);

  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.invalidRows, [
    { fileId: 21, articleId: 9, code: 'UNSAFE_FILENAME' },
    { fileId: 23, articleId: 9, code: 'VIDEO_NOT_COMPLETED', transcodeStatus: 'processing' },
  ]);
  assert.deepEqual(result.missingAssets, [
    { fileId: 22, articleId: 9, variant: 'video' },
    { fileId: 22, articleId: 9, variant: 'poster' },
  ]);
});

test('media catalog treats legacy published rows without file_type as images', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'legacy.jpg'), 'legacy');
  const catalog = createMediaCatalog({ database: databaseWithRows([]), imageRoot, videoRoot });

  const result = await catalog.discoverVariants([{ id: 24, articleId: 9, filename: 'legacy.jpg', mimetype: 'image/jpeg', fileType: null }]);

  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.fileId, candidate.fileType, candidate.variant]),
    [[24, 'image', 'original']],
  );
  assert.deepEqual(result.invalidRows, []);
});

test('inventory reports exact object totals, filesystem extras and structured nodes without stable IDs', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'known.jpg'), 'known');
  await fs.writeFile(path.join(imageRoot, 'known-small.jpg'), 'small');
  await fs.writeFile(path.join(imageRoot, 'outside.jpg'), 'outside');
  const files = [{ id: 31, articleId: 10, filename: 'known.jpg', mimetype: 'image/jpeg', fileType: 'image' }];
  const articles = [
    {
      id: 10,
      content: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { src: '/legacy.jpg' } },
          { type: 'video', attrs: { videoId: 44, src: '/video.mp4' } },
        ],
      },
    },
  ];
  const database = databaseWithRows(files, articles);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  const report = await inventoryMedia({ catalog, database, limit: 100 });

  assert.equal(report.published.logicalFiles, 1);
  assert.equal(report.published.physicalObjects, 2);
  assert.equal(report.published.bytes, 10);
  assert.deepEqual(report.filesystemFilesWithoutDatabase, [path.join(imageRoot, 'outside.jpg')]);
  assert.deepEqual(report.legacyContentWithoutStableMediaId, [{ articleId: 10, nodeType: 'image' }]);
  assert.equal(report.nextAfterFileId, 31);
  assert.equal(report.filesystemCoverageComplete, true);
});

test('filtered inventory marks filesystem coverage incomplete instead of reporting unrelated files as extras', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'selected.jpg'), 'selected');
  await fs.writeFile(path.join(imageRoot, 'another-article.jpg'), 'another');
  const database = databaseWithRows([{ id: 41, articleId: 12, filename: 'selected.jpg', mimetype: 'image/jpeg', fileType: 'image' }]);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  const report = await inventoryMedia({ catalog, database, articleId: 12, limit: 1 });

  assert.equal(report.filesystemCoverageComplete, false);
  assert.deepEqual(report.filesystemFilesWithoutDatabase, []);
});

test('unfiltered media inventory includes article and Flow-owned files while preserving nullable ownership', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'article.jpg'), 'article');
  await fs.writeFile(path.join(imageRoot, 'flow.jpg'), 'flow');
  const database = databaseWithRows([
    { id: 51, articleId: 12, flowId: null, draftId: null, filename: 'article.jpg', mimetype: 'image/jpeg', fileType: 'image' },
    { id: 52, articleId: null, flowId: 91, draftId: null, filename: 'flow.jpg', mimetype: 'image/jpeg', fileType: 'image' },
  ]);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  const files = await catalog.listPublishedFiles({ afterFileId: 50, limit: 10 });
  const report = await inventoryMedia({ catalog, database, afterFileId: 50, limit: 10 });

  assert.match(database.calls[0].statement, /LEFT JOIN flow_post_media fm ON fm\.file_id = f\.id/i);
  assert.match(database.calls[0].statement, /f\.article_id IS NOT NULL\s+OR\s+fm\.file_id IS NOT NULL/i);
  assert.deepEqual(
    files.map(({ id, articleId, flowId, draftId }) => ({ id, articleId, flowId, draftId })),
    [
      { id: 51, articleId: 12, flowId: null, draftId: null },
      { id: 52, articleId: null, flowId: 91, draftId: null },
    ],
  );
  assert.equal(report.published.logicalFiles, 2);
  assert.equal(report.published.physicalObjects, 2);
  assert.deepEqual(report.invalidRows, []);
  assert.deepEqual(
    (await catalog.discoverVariants(files)).candidates.map(({ fileId, articleId, flowId }) => ({ fileId, articleId, flowId })),
    [
      { fileId: 51, articleId: 12, flowId: undefined },
      { fileId: 52, articleId: null, flowId: 91 },
    ],
  );
});

test('catalog and inventory quarantine dual-published and still-draft-bound Flow rows before filesystem discovery', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'dual.jpg'), 'dual');
  await fs.writeFile(path.join(imageRoot, 'flow-draft.jpg'), 'flow-draft');
  const rows = [
    { id: 61, articleId: 12, flowId: 91, draftId: null, filename: 'dual.jpg', mimetype: 'image/jpeg', fileType: 'image' },
    { id: 62, articleId: null, flowId: 92, draftId: 71, filename: 'flow-draft.jpg', mimetype: 'image/jpeg', fileType: 'image' },
  ];
  const database = databaseWithRows(rows);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  const files = await catalog.listPublishedFiles({ afterFileId: 60, limit: 10 });
  const discovered = await catalog.discoverVariants(files);
  const report = await inventoryMedia({ catalog, database, afterFileId: 60, limit: 10 });

  assert.match(database.calls[0].statement, /f\.draft_id AS "draftId"/i);
  assert.deepEqual(
    files.map(({ id, articleId, flowId, draftId }) => ({ id, articleId, flowId, draftId })),
    [
      { id: 61, articleId: 12, flowId: 91, draftId: null },
      { id: 62, articleId: null, flowId: 92, draftId: 71 },
    ],
  );
  assert.deepEqual(discovered.candidates, []);
  assert.deepEqual(discovered.missingAssets, []);
  assert.deepEqual(discovered.optionalMissingAssets, []);
  assert.deepEqual(discovered.invalidRows, [
    { fileId: 61, articleId: 12, flowId: 91, code: 'MULTIPLE_PUBLISHED_OWNERS' },
    { fileId: 62, articleId: null, flowId: 92, draftId: 71, code: 'FLOW_MEDIA_STILL_DRAFT_BOUND' },
  ]);
  assert.deepEqual(report.invalidRows, discovered.invalidRows);
  assert.equal(report.published.physicalObjects, 0);
});

test('article-filtered catalog returns a dual-owned row for audit while its article predicate excludes pure Flow rows', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  await fs.writeFile(path.join(imageRoot, 'dual.jpg'), 'dual');
  const database = databaseWithRows([{ id: 63, articleId: 12, flowId: 91, draftId: null, filename: 'dual.jpg', mimetype: 'image/jpeg', fileType: 'image' }]);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  const files = await catalog.listPublishedFiles({ articleId: 12, afterFileId: 60, limit: 10 });
  const discovered = await catalog.discoverVariants(files);

  assert.match(database.calls[0].statement, /f\.article_id = \?/i);
  assert.doesNotMatch(database.calls[0].statement, /fm\.flow_id = \?/i);
  assert.deepEqual(
    files.map((file) => file.id),
    [63],
  );
  assert.deepEqual(discovered.invalidRows, [{ fileId: 63, articleId: 12, flowId: 91, code: 'MULTIPLE_PUBLISHED_OWNERS' }]);
  assert.deepEqual(discovered.candidates, []);
});

test('article-filtered media catalog remains article-only', async (t) => {
  const { imageRoot, videoRoot } = await fixtureRoots(t);
  const database = databaseWithRows([]);
  const catalog = createMediaCatalog({ database, imageRoot, videoRoot });

  await catalog.listPublishedFiles({ articleId: 12, afterFileId: 50, limit: 10 });

  assert.deepEqual(database.calls[0].params, [50, 12, 10]);
  assert.match(database.calls[0].statement, /f\.article_id IS NOT NULL/i);
  assert.match(database.calls[0].statement, /f\.article_id = \?/i);
});
