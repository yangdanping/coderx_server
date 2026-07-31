const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const { LocalMediaCleanupService, buildLocalCleanupEntries } = require('@/service/localMediaCleanup.service');

test('buildLocalCleanupEntries records exact image variants and video/poster filenames', () => {
  assert.deepEqual(
    buildLocalCleanupEntries([
      { file_type: 'image', filename: 'cover.jpg' },
      { file_type: 'video', filename: 'clip.mp4', poster: 'clip-poster.jpg' },
    ]),
    [
      { storageArea: 'image', filename: 'cover.jpg' },
      { storageArea: 'image', filename: 'cover-small.jpg' },
      { storageArea: 'video', filename: 'clip.mp4' },
      { storageArea: 'video', filename: 'clip-poster.jpg' },
    ],
  );
});

test('enqueueInTransaction persists cleanup filenames before logical rows disappear', async () => {
  const calls = [];
  const service = new LocalMediaCleanupService({
    database: { async getConnection() {} },
    roots: { image: '/tmp/images', video: '/tmp/videos' },
    fsPromises: { async unlink() {} },
  });
  const conn = {
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ insertId: calls.length, affectedRows: 1 }, []];
    },
  };

  const ids = await service.enqueueInTransaction(conn, [
    { storageArea: 'video', filename: 'clip.mp4' },
    { storageArea: 'video', filename: 'clip-poster.jpg' },
  ]);

  assert.deepEqual(ids, [1, 2]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].statement, /INSERT INTO media_local_cleanup/i);
  assert.match(calls[0].statement, /ON CONFLICT/i);
  assert.deepEqual(calls[0].params, ['video', 'clip.mp4']);
});

test('processPending keeps a durable tombstone after unlink failure and removes it on restart retry', async () => {
  const databaseCalls = [];
  let processRun = 0;
  const database = {
    async getConnection() {
      processRun += 1;
      return {
        async beginTransaction() {},
        async execute(statement, params) {
          databaseCalls.push({ run: processRun, statement, params });
          if (/SELECT[\s\S]+FROM media_local_cleanup/i.test(statement)) {
            return [[{ id: 8, storageArea: 'video', filename: 'clip.mp4', attemptCount: processRun - 1 }], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
  let unlinkCalls = 0;
  const fsPromises = {
    async unlink(filePath) {
      unlinkCalls += 1;
      assert.equal(filePath, path.resolve('/srv/video', 'clip.mp4'));
      if (unlinkCalls === 1) {
        const error = new Error('temporary EIO');
        error.code = 'EIO';
        throw error;
      }
    },
  };

  const firstProcess = new LocalMediaCleanupService({ database, fsPromises, roots: { image: '/srv/img', video: '/srv/video' } });
  assert.deepEqual(await firstProcess.processPending({ ids: [8] }), {
    examined: 1,
    deleted: 0,
    missing: 0,
    failed: 1,
    pendingIds: [8],
  });
  assert.equal(
    databaseCalls.some((call) => call.run === 1 && /UPDATE media_local_cleanup/i.test(call.statement)),
    true,
  );
  assert.equal(
    databaseCalls.some((call) => call.run === 1 && /DELETE FROM media_local_cleanup/i.test(call.statement)),
    false,
  );

  const restartedProcess = new LocalMediaCleanupService({ database, fsPromises, roots: { image: '/srv/img', video: '/srv/video' } });
  assert.deepEqual(await restartedProcess.processPending({ ids: [8] }), {
    examined: 1,
    deleted: 1,
    missing: 0,
    failed: 0,
    pendingIds: [],
  });
  assert.equal(
    databaseCalls.some((call) => call.run === 2 && /DELETE FROM media_local_cleanup/i.test(call.statement)),
    true,
  );
});

test('processPending treats an already-missing file as successful idempotent cleanup', async () => {
  const calls = [];
  const database = {
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement) {
          calls.push(statement);
          if (/SELECT[\s\S]+FROM media_local_cleanup/i.test(statement)) {
            return [[{ id: 9, storageArea: 'video', filename: 'gone.mp4', attemptCount: 0 }], []];
          }
          return [{ affectedRows: 1 }, []];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
  const fsPromises = {
    async unlink() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  };
  const service = new LocalMediaCleanupService({ database, fsPromises, roots: { image: '/srv/img', video: '/srv/video' } });

  const result = await service.processPending({ ids: [9] });

  assert.equal(result.missing, 1);
  assert.equal(result.failed, 0);
  assert.equal(
    calls.some((statement) => /DELETE FROM media_local_cleanup/i.test(statement)),
    true,
  );
});
