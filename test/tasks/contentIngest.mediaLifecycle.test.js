const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('module-alias/register');
const { backfillRawArticles } = require('@/ingest/pipeline/backfillRawArticles');
const { backfillRichArticles } = require('@/ingest/pipeline/backfillRichArticles');

async function fixture(t, { rich = false, failPersistence = false, failCleanup = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-ingest-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = { id: 3, articleId: rich ? 100 : null, status: rich ? 'published' : 'pending', sourceName: 'Example', canonicalUrl: 'https://example.com/a' };
  const removed = [];
  const repository = {
    async listRawCandidatesByIds() {
      return [candidate];
    },
    async listPublishedCandidatesByIds() {
      return [candidate];
    },
    async publishRawArticle(input) {
      return persist(input);
    },
    async replacePublishedArticle(input) {
      return persist(input);
    },
  };
  async function persist(input) {
    if (failPersistence) throw new Error('transaction failed');
    return { articleId: 100, images: input.assets.map((asset) => ({ ...asset, id: 500 })), oldFilenames: failCleanup ? ['ingest-3-old.jpg'] : [] };
  }
  const args = {
    repository,
    ids: [3],
    authorIds: [1, 2],
    tagName: 'AI',
    outputDir: root,
    publicBaseURL: 'http://localhost:8000',
    extractor: async () => ({ title: 'Source article', sections: [{ heading: 'Body', paragraphs: ['A useful source excerpt.'] }], images: [{}] }),
    enricher: {
      async enrich() {
        return { titleZh: 'Article', lead: 'Summary', sections: [] };
      },
    },
    async localizeImages({ outputDir }) {
      const filename = 'ingest-3-1-1234567890.jpg';
      const smallFilename = 'ingest-3-1-1234567890-small.jpg';
      const temporaryPath = path.join(outputDir, filename);
      const smallTemporaryPath = path.join(outputDir, smallFilename);
      await fs.writeFile(temporaryPath, 'original');
      await fs.writeFile(smallTemporaryPath, 'small');
      return { assets: [{ filename, smallFilename, temporaryPath, smallTemporaryPath, size: 8, mimetype: 'image/jpeg', width: 1200, height: 675 }], async cleanup() {} };
    },
    async deleteStoredFiles(files) {
      removed.push(...files);
      if (failCleanup && files.includes('ingest-3-old.jpg')) throw new Error('cleanup failed');
      await Promise.all(files.map((file) => fs.rm(file, { force: true })));
    },
  };
  return { root, args, removed, run: rich ? backfillRichArticles : backfillRawArticles };
}

for (const rich of [false, true]) {
  test(`${rich ? 'rich replacement' : 'raw creation'} preserves committed files and reports media retry after sync failure`, async (t) => {
    const f = await fixture(t, { rich });
    const synchronized = [];
    f.args.synchronizeMedia = async (payload) => {
      synchronized.push(payload);
      throw new Error('upload failed');
    };
    const result = await f.run(f.args);
    assert.equal(result[rich ? 'updated' : 'created'], 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(f.removed, []);
    assert.equal(result.articles[0].media.status, 'retry_required');
    assert.equal(result.articles[0].media.reason, 'upload failed');
    assert.deepEqual(synchronized, [{ articleId: 100 }]);
    assert.equal(await fs.readFile(path.join(f.root, 'ingest-3-1-1234567890.jpg'), 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(f.root, 'ingest-3-1-1234567890-small.jpg'), 'utf8'), 'small');
  });
  test(`${rich ? 'rich' : 'raw'} precommit rollback removes only new copies`, async (t) => {
    const f = await fixture(t, { rich, failPersistence: true });
    f.args.synchronizeMedia = async () => {
      throw new Error('must not synchronize');
    };
    const result = await f.run(f.args);
    assert.equal(result.failed, 1);
    assert.equal(f.removed.length, 2);
    await assert.rejects(fs.access(path.join(f.root, 'ingest-3-1-1234567890.jpg')), { code: 'ENOENT' });
  });
  test(`${rich ? 'rich' : 'raw'} postcommit cleanup failure never compensates committed copies`, async (t) => {
    const f = await fixture(t, { rich, failCleanup: true });
    const result = await f.run(f.args);
    assert.equal(result[rich ? 'updated' : 'created'], 1);
    assert.equal(result.failed, 0);
    assert.equal(result.articles[0].media.status, 'retry_required');
    assert.deepEqual(f.removed, ['ingest-3-old.jpg']);
    assert.equal(await fs.readFile(path.join(f.root, 'ingest-3-1-1234567890.jpg'), 'utf8'), 'original');
  });
}

test('asset copying compensates a partial copy failure before persistence', async (t) => {
  const { promoteArticleAssets } = require('@/ingest/pipeline/backfillRichArticles');
  const f = await fixture(t);
  const source = path.join(f.root, 'source');
  await fs.writeFile(source, 'new original');
  const dest = path.join(f.root, 'public');
  await assert.rejects(
    promoteArticleAssets([{ filename: 'ingest-3-new.jpg', smallFilename: 'ingest-3-new-small.jpg', temporaryPath: source, smallTemporaryPath: path.join(f.root, 'missing') }], {
      outputDir: dest,
      publicBaseURL: 'http://localhost',
    }),
    { code: 'ENOENT' },
  );
  await assert.rejects(fs.access(path.join(dest, 'ingest-3-new.jpg')), { code: 'ENOENT' });
});

test('immutable destination conflict never replaces or deletes published bytes', async (t) => {
  const { promoteArticleAssets } = require('@/ingest/pipeline/backfillRichArticles');
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'source'), 'changed');
  await fs.writeFile(path.join(f.root, 'ingest-3-old.jpg'), 'published');
  await assert.rejects(
    promoteArticleAssets(
      [{ filename: 'ingest-3-old.jpg', smallFilename: 'ingest-3-old-small.jpg', temporaryPath: path.join(f.root, 'source'), smallTemporaryPath: path.join(f.root, 'source') }],
      { outputDir: f.root, publicBaseURL: 'http://localhost' },
    ),
    /immutable content/i,
  );
  assert.equal(await fs.readFile(path.join(f.root, 'ingest-3-old.jpg'), 'utf8'), 'published');
});

test('temporary asset cleanup failure still returns committed article and media outcome', async (t) => {
  const f = await fixture(t);
  const localize = f.args.localizeImages;
  f.args.localizeImages = async (input) => ({
    ...(await localize(input)),
    async cleanup() {
      throw new Error('temporary cleanup failed');
    },
  });
  f.args.synchronizeMedia = async () => ({ status: 'ready' });
  const result = await f.run(f.args);
  assert.equal(result.created, 1);
  assert.equal(result.articles[0].media.status, 'ready');
  assert.equal(result.articles[0].cleanupWarnings[0], 'temporary cleanup failed');
  assert.equal(await fs.readFile(path.join(f.root, 'ingest-3-1-1234567890.jpg'), 'utf8'), 'original');
});
