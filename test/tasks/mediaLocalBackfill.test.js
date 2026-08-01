const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('module-alias/register');

const { backfillLocalMediaObjects } = require('@/tasks/backfillLocalMediaObjects');

const CONTENT = Buffer.from('historical-image');
const SHA256 = crypto.createHash('sha256').update(CONTENT).digest('hex');
const CANDIDATE = {
  articleId: 7,
  fileId: 11,
  fileType: 'image',
  variant: 'original',
  localPath: '/srv/coderx/public/img/known.jpg',
  filename: 'known.jpg',
  contentType: 'image/jpeg',
  sizeBytes: CONTENT.length,
};

function catalogFixture(candidates = [CANDIDATE], extras = {}) {
  const calls = [];
  return {
    calls,
    catalog: {
      async listPublishedFiles(options) {
        calls.push({ type: 'list', options });
        return candidates.map((candidate) => ({ id: candidate.fileId, articleId: candidate.articleId }));
      },
      async discoverVariants() {
        return {
          candidates,
          missingAssets: extras.missingAssets || [],
          optionalMissingAssets: [],
          invalidRows: extras.invalidRows || [],
        };
      },
    },
  };
}

function databaseFixture(existingRows = []) {
  const calls = [];
  let inserted = false;
  const conn = {
    async beginTransaction() {
      calls.push('begin');
    },
    async execute(statement, params) {
      calls.push({ statement, params });
      if (/SELECT[\s\S]*FROM media_object[\s\S]*FOR UPDATE/i.test(statement)) return [existingRows, []];
      if (/INSERT INTO media_object/i.test(statement)) {
        inserted = true;
        return [{ affectedRows: 1, insertId: 71 }, []];
      }
      if (/UPDATE media_object/i.test(statement)) return [{ affectedRows: 1 }, []];
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    async commit() {
      calls.push('commit');
    },
    async rollback() {
      calls.push('rollback');
    },
    release() {
      calls.push('release');
    },
  };
  return {
    calls,
    get inserted() {
      return inserted;
    },
    database: {
      async getConnection() {
        calls.push('getConnection');
        return conn;
      },
    },
  };
}

const inspector = async () => ({ sizeBytes: CONTENT.length, sha256: SHA256 });

test('local backfill dry-run hashes candidates and performs zero database writes', async () => {
  const { catalog, calls } = catalogFixture();
  let connected = false;
  const result = await backfillLocalMediaObjects({
    catalog,
    database: {
      async execute() {
        return [[], []];
      },
      async getConnection() {
        connected = true;
        throw new Error('dry-run must not connect for writes');
      },
    },
    inspector,
    dryRun: true,
    articleId: 7,
    afterFileId: 10,
    limit: 5,
  });

  assert.equal(connected, false);
  assert.deepEqual(calls[0], { type: 'list', options: { articleId: 7, afterFileId: 10, limit: 5 } });
  assert.equal(result.dryRun, true);
  assert.equal(result.candidateObjects, 1);
  assert.equal(result.candidateBytes, CONTENT.length);
  assert.equal(result.wouldInsert, 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 0);
});

test('local backfill inserts a verified ready local row transactionally', async () => {
  const { catalog } = catalogFixture();
  const fixture = databaseFixture();

  const result = await backfillLocalMediaObjects({ catalog, database: fixture.database, inspector, dryRun: false });

  assert.equal(result.inserted, 1);
  assert.equal(result.idempotent, 0);
  assert.equal(result.failed, 0);
  assert.equal(fixture.inserted, true);
  const insert = fixture.calls.find((call) => typeof call === 'object' && /INSERT INTO media_object/i.test(call.statement));
  assert.deepEqual(insert.params, [11, 'local', 'original', CANDIDATE.localPath, CONTENT.length, SHA256, 'ready']);
  assert.deepEqual(
    fixture.calls.filter((call) => typeof call === 'string'),
    ['getConnection', 'begin', 'commit', 'release'],
  );
});

test('local backfill treats an exact ready row as idempotent and refuses immutable conflicts', async () => {
  const { catalog } = catalogFixture();
  const exact = databaseFixture([
    {
      id: 71,
      localPath: CANDIDATE.localPath,
      sizeBytes: CONTENT.length,
      sha256: SHA256,
      status: 'ready',
    },
  ]);
  const exactResult = await backfillLocalMediaObjects({ catalog, database: exact.database, inspector, dryRun: false });
  assert.equal(exactResult.idempotent, 1);
  assert.equal(exact.inserted, false);

  const conflict = databaseFixture([
    {
      id: 72,
      localPath: CANDIDATE.localPath,
      sizeBytes: CONTENT.length + 1,
      sha256: '0'.repeat(64),
      status: 'ready',
    },
  ]);
  const conflictResult = await backfillLocalMediaObjects({ catalog, database: conflict.database, inspector, dryRun: false });
  assert.equal(conflictResult.failed, 1);
  assert.equal(conflictResult.failures[0].code, 'LOCAL_MEDIA_OBJECT_CONFLICT');
  assert.equal(conflict.inserted, false);
  assert.deepEqual(
    conflict.calls.filter((call) => typeof call === 'string'),
    ['getConnection', 'begin', 'rollback', 'release'],
  );
});

test('local backfill reports catalog gaps and continues after one row transaction fails', async () => {
  const second = { ...CANDIDATE, fileId: 12, filename: 'second.jpg', localPath: '/srv/coderx/public/img/second.jpg' };
  const { catalog } = catalogFixture([CANDIDATE, second], {
    missingAssets: [{ fileId: 13, articleId: 7, variant: 'original' }],
  });
  let connectionNumber = 0;
  const fixture = databaseFixture();
  const database = {
    async getConnection() {
      connectionNumber += 1;
      if (connectionNumber === 1) throw new Error('database unavailable');
      return fixture.database.getConnection();
    },
  };

  const result = await backfillLocalMediaObjects({ catalog, database, inspector, dryRun: false });

  assert.equal(result.inserted, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.missingAssets, [{ fileId: 13, articleId: 7, variant: 'original' }]);
  assert.equal(result.failures[0].fileId, 11);
});
