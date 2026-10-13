const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
require('module-alias/register');

function createDatabase(images) {
  const rows = new Map();
  let nextId = 1;
  return {
    rows,
    async execute(sql) {
      if (/FROM article_source/i.test(sql)) return [[{ candidateId: 3 }], []];
      if (/FROM file f/i.test(sql)) return [images, []];
      throw new Error(`unexpected root SQL ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async execute(sql, params) {
          if (/FROM media_object/i.test(sql)) return [[rows.get(`${params[0]}/${params[1]}`)].filter(Boolean), []];
          if (/INSERT INTO media_object/i.test(sql)) {
            rows.set(`${params[0]}/${params[2]}`, { id: nextId++, localPath: params[3], sizeBytes: params[4], sha256: params[5], status: params[6] });
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM file f/i.test(sql)) return [[], []];
          if (/FROM media_local_cleanup/i.test(sql)) return [[], []];
          return [{ affectedRows: 1 }, []];
        },
      };
    },
  };
}
async function setup(t, options = {}) {
  const { createIngestMediaService } = require('@/ingest/media/ingestMediaService');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-ingest-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'ingest-3-cover.jpg'), 'original');
  await fs.writeFile(path.join(root, 'ingest-3-cover-small.jpg'), 'small');
  const images = [{ id: 50, articleId: 100, filename: 'ingest-3-cover.jpg', mimetype: 'image/jpeg', fileType: 'image' }];
  const database = createDatabase(images);
  const promoted = [];
  const service = createIngestMediaService({
    database,
    imageRoot: root,
    videoRoot: root,
    writeMode: 'r2_on_publish',
    mediaPromotionService: {
      async promote(payload) {
        promoted.push(payload);
        return { skipped: false };
      },
    },
    ...options,
  });
  return { root, database, service, promoted };
}

test('ingest media class imports without initializing the global app database', () => {
  execFileSync(
    process.execPath,
    [
      '-e',
      `require('module-alias/register'); const id = require.resolve('@/app/database'); require('@/ingest/media/ingestMediaService'); if (require.cache[id]) throw new Error('global app pool loaded');`,
    ],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});
test('sync registers original and small with the injected database before shared promotion', async (t) => {
  const f = await setup(t);
  const result = await f.service.synchronizeArticle({ articleId: 100 });
  assert.equal(result.status, 'ready');
  assert.equal(result.registration.inserted, 2);
  assert.equal(f.database.rows.size, 2);
  assert.deepEqual(
    f.promoted.map((p) => [p.fileId, p.variant, p.articleId]),
    [
      [50, 'original', 100],
      [50, 'small', 100],
    ],
  );
  const repeated = await f.service.synchronizeArticle({ articleId: 100 });
  assert.equal(repeated.status, 'ready');
  assert.equal(repeated.registration.idempotent, 2);
  assert.equal(f.database.rows.size, 2);
});
for (const flags of [{ writeMode: 'local' }, { writePaused: true }]) {
  test(`sync registers local variants when promotion is disabled: ${JSON.stringify(flags)}`, async (t) => {
    const f = await setup(t, flags);
    const result = await f.service.synchronizeArticle({ articleId: 100 });
    assert.equal(result.status, 'local_ready');
    assert.equal(result.registration.inserted, 2);
    assert.equal(f.promoted.length, 0);
  });
}
test('missing required ingest thumbnail never reports complete R2 publication', async (t) => {
  const f = await setup(t);
  await fs.rm(path.join(f.root, 'ingest-3-cover-small.jpg'));
  const result = await f.service.synchronizeArticle({ articleId: 100 });
  assert.equal(result.status, 'retry_required');
  assert.equal(result.registration.missingAssets.length, 1);
  assert.equal(f.promoted.length, 0);
});
test('in-progress and failed promotions both require retry', async (t) => {
  let run = 0;
  const f = await setup(t, {
    mediaPromotionService: {
      async promote() {
        if (run++ === 0) return { inProgress: true };
        throw new Error('R2 failed');
      },
    },
  });
  const result = await f.service.synchronizeArticle({ articleId: 100 });
  assert.equal(result.status, 'retry_required');
  assert.equal(result.promotion.inProgress, 1);
  assert.equal(result.promotion.failed, 1);
});
test('mutation pause prevents all registration, upload and cleanup writes', async (t) => {
  const f = await setup(t, { mutationsPaused: true });
  const result = await f.service.synchronizeArticle({ articleId: 100 });
  assert.equal(result.status, 'retry_required');
  assert.equal(result.reason, 'media_mutations_paused');
  assert.equal(f.database.rows.size, 0);
  assert.equal(f.promoted.length, 0);
});
