import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIngestMediaService } from '../../src/ingest/media/ingestMediaService.js';

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
  const project = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync(
    process.execPath,
    [
      '--require', './test/support/runtime-guard.cjs',
      '--import=tsx',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
      import pg from 'pg';
      pg.Pool = class { constructor() { assert.fail('global app pool initialized'); } };
      const { createIngestMediaService } = await import('./src/ingest/media/ingestMediaService.ts');
      assert.equal(typeof createIngestMediaService, 'function');`,
    ],
    { cwd: project, env: { PATH: process.env.PATH }, stdio: 'pipe' },
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

test('retirement reports only committed file deletions when a later row fails', async (t) => {
  let enqueued = 0;
  const f = await setup(t, {
    localCleanup: {
      async enqueueInTransaction() {
        if (++enqueued === 2) throw new Error('queue unavailable');
        return [1];
      },
      async processPending() {
        throw new Error('must not process rolled-back tombstones');
      },
    },
  });
  const getConnection = f.database.getConnection;
  f.database.getConnection = async () => {
    const conn = await getConnection();
    const execute = conn.execute;
    conn.execute = async (sql, params) => {
      if (/FROM file f/i.test(sql))
        return [
          [
            { id: 90, filename: 'ingest-3-retired-a.jpg', file_type: 'image' },
            { id: 91, filename: 'ingest-3-retired-b.jpg', file_type: 'image' },
          ],
          [],
        ];
      if (/SELECT id FROM file/i.test(sql)) return [[], []];
      return execute(sql, params);
    };
    return conn;
  };
  const result = await f.service.synchronizeArticle({ articleId: 100 });
  assert.equal(result.status, 'retry_required');
  assert.equal(result.cleanup.deleted, 0, 'the candidate cleanup transaction rolled back');
  assert.equal(result.cleanup.failures[0].message, 'queue unavailable');
});
