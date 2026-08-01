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
