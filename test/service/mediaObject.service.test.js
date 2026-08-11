const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('module-alias/register');

const { MediaCapacityExceededError, MediaObjectConflictError, MediaObjectStateTransitionError, createMediaObjectService } = require('@/service/mediaObject.service');
const { MEDIA_CAPACITY_ADVISORY_LOCK_KEY } = require('@/constants/mediaStorage');

const SHA256 = crypto.createHash('sha256').update('capacity fixture').digest('hex');

function createDatabaseMock(executeHandler) {
  const calls = [];
  const conn = {
    async beginTransaction() {
      calls.push({ type: 'begin' });
    },
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      return executeHandler(statement, params, calls);
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
    release() {
      calls.push({ type: 'release' });
    },
  };
  return {
    calls,
    database: {
      async getConnection() {
        return conn;
      },
      async execute(statement, params) {
        calls.push({ type: 'rootExecute', statement, params });
        return executeHandler(statement, params, calls);
      },
    },
  };
}

test('mediaObjectService: reserves pending capacity inside an advisory-locked PostgreSQL transaction', async () => {
  const objectKey = `articles/88/images/512/${SHA256.slice(0, 12)}-original.jpg`;
  const { calls, database } = createDatabaseMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) return [[{}], []];
    if (/FROM media_object/i.test(statement) && /FOR UPDATE/i.test(statement)) return [[], []];
    if (/COALESCE\s*\(\s*SUM/i.test(statement)) return [[{ reservedBytes: 400 }], []];
    if (/INSERT INTO media_object/i.test(statement)) return [{ insertId: 71, affectedRows: 1 }, []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = createMediaObjectService({ database, hardLimitBytes: 1_000 });

  const result = await service.reserveR2Object({
    fileId: 512,
    variant: 'original',
    objectKey,
    sizeBytes: 500,
    sha256: SHA256,
  });

  assert.equal(result.reserved, true);
  assert.equal(result.reservedBytes, 900);
  assert.deepEqual(result.mediaObject, {
    id: 71,
    fileId: 512,
    provider: 'r2',
    variant: 'original',
    objectKey,
    localPath: null,
    sizeBytes: 500,
    sha256: SHA256,
    status: 'pending',
  });

  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.match(executeCalls[0].statement, /SELECT\s+pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*\?::text\s*,\s*0\s*\)\s*\)/i);
  assert.deepEqual(executeCalls[0].params, [MEDIA_CAPACITY_ADVISORY_LOCK_KEY]);
  assert.match(executeCalls[1].statement, /provider\s*=\s*'r2'[\s\S]*FOR UPDATE/i);
  assert.deepEqual(executeCalls[1].params, [512, 'original']);
  assert.match(executeCalls[2].statement, /status\s+IN\s*\(\s*\?\s*,\s*\?\s*\)/i);
  assert.deepEqual(executeCalls[2].params, ['pending', 'ready']);
  assert.match(executeCalls[3].statement, /INSERT INTO media_object/i);
  assert.deepEqual(executeCalls[3].params, [512, 'r2', 'original', objectKey, 500, SHA256, 'pending']);
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'begin' }, { type: 'commit' }, { type: 'release' }],
  );
});

test('mediaObjectService: rejects a reservation above the 7GB hard limit without creating pending state', async () => {
  const { calls, database } = createDatabaseMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) return [[{}], []];
    if (/FOR UPDATE/i.test(statement)) return [[], []];
    if (/COALESCE\s*\(\s*SUM/i.test(statement)) return [[{ reservedBytes: 6_999_999_990 }], []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = createMediaObjectService({ database, hardLimitBytes: 7_000_000_000 });

  await assert.rejects(
    service.reserveR2Object({
      fileId: 512,
      variant: 'original',
      objectKey: 'articles/88/images/512/hash-original.jpg',
      sizeBytes: 11,
      sha256: SHA256,
    }),
    (error) => {
      assert.equal(error instanceof MediaCapacityExceededError, true);
      assert.match(error.message, /7000000000|hard limit|容量/i);
      assert.equal(error.currentBytes, 6_999_999_990);
      assert.equal(error.requestedBytes, 11);
      return true;
    },
  );

  assert.equal(
    calls.some((call) => call.type === 'execute' && /INSERT INTO media_object/i.test(call.statement)),
    false,
  );
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'begin' }, { type: 'rollback' }, { type: 'release' }],
  );
});

test('mediaObjectService: identical pending or ready reservations are idempotent and do not add capacity twice', async () => {
  const existing = {
    id: 71,
    fileId: 512,
    provider: 'r2',
    variant: 'original',
    objectKey: 'articles/88/images/512/hash-original.jpg',
    localPath: null,
    sizeBytes: 500,
    sha256: SHA256,
    status: 'ready',
  };
  const { calls, database } = createDatabaseMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) return [[{}], []];
    if (/FOR UPDATE/i.test(statement)) return [[existing], []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = createMediaObjectService({ database, hardLimitBytes: 1_000 });

  const result = await service.reserveR2Object({
    fileId: 512,
    variant: 'original',
    objectKey: existing.objectKey,
    sizeBytes: 500,
    sha256: SHA256,
  });

  assert.deepEqual(result, {
    reserved: false,
    reservedBytes: null,
    mediaObject: existing,
  });
  assert.equal(
    calls.some((call) => call.type === 'execute' && /SUM|INSERT/i.test(call.statement)),
    false,
  );
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'begin' }, { type: 'commit' }, { type: 'release' }],
  );
});

test('mediaObjectService: a failed neutral reservation can be reserved again after recovery', async () => {
  const objectKey = `media/images/512/${SHA256.slice(0, 12)}-original.webp`;
  const existing = {
    id: 71,
    fileId: 512,
    provider: 'r2',
    variant: 'original',
    objectKey,
    localPath: null,
    sizeBytes: 500,
    sha256: SHA256,
    status: 'failed',
  };
  const { calls, database } = createDatabaseMock((statement) => {
    if (/pg_advisory_xact_lock/i.test(statement)) return [[{}], []];
    if (/FROM media_object/i.test(statement) && /FOR UPDATE/i.test(statement)) return [[existing], []];
    if (/COALESCE\s*\(\s*SUM/i.test(statement)) return [[{ reservedBytes: 0 }], []];
    if (/UPDATE media_object/i.test(statement) && /status\s*=\s*'pending'/i.test(statement)) return [{ affectedRows: 1 }, []];
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = createMediaObjectService({ database, hardLimitBytes: 1_000 });

  const result = await service.reserveR2Object({ fileId: 512, variant: 'original', objectKey, sizeBytes: 500, sha256: SHA256 });

  assert.equal(result.reserved, true);
  assert.equal(result.mediaObject.status, 'pending');
  const retryUpdate = calls.find((call) => call.type === 'execute' && /UPDATE media_object/i.test(call.statement));
  assert.ok(retryUpdate);
  assert.deepEqual(retryUpdate.params, [objectKey, 500, SHA256, 71]);
});

test('mediaObjectService: capacity summary counts only R2 pending and ready rows', async () => {
  const { calls, database } = createDatabaseMock((statement) => {
    assert.match(statement, /provider\s*=\s*'r2'/i);
    assert.match(statement, /status\s+IN\s*\(\s*\?\s*,\s*\?\s*\)/i);
    return [[{ reservedBytes: 321 }], []];
  });
  const service = createMediaObjectService({ database });

  assert.equal(await service.getR2ReservedBytes(), 321);
  const call = calls.find((item) => item.type === 'rootExecute');
  assert.deepEqual(call.params, ['pending', 'ready']);
});

test('mediaObjectService: marks verified objects ready and failures failed with a bounded error', async () => {
  const { calls, database } = createDatabaseMock(() => [{ affectedRows: 1 }, []]);
  const service = createMediaObjectService({ database });
  const readyObject = {
    id: 71,
    objectKey: `articles/88/images/512/${SHA256.slice(0, 12)}-original.jpg`,
    sizeBytes: 123,
    sha256: SHA256,
  };
  const failedObject = {
    ...readyObject,
    id: 72,
  };

  await service.markReady(readyObject);
  await service.markFailed(failedObject, new Error('upload unavailable'));
  await service.markVerificationFailed(readyObject, new Error('R2 HEAD mismatch'));

  const [readyCall, failedCall, verificationCall] = calls.filter((call) => call.type === 'rootExecute');
  assert.match(readyCall.statement, /status\s*=\s*'ready'[\s\S]*verified_at\s*=\s*clock_timestamp/i);
  assert.match(readyCall.statement, /object_key\s*=\s*\?[\s\S]*size_bytes\s*=\s*\?[\s\S]*sha256\s*=\s*\?/i);
  assert.deepEqual(readyCall.params, [71, readyObject.objectKey, 123, SHA256]);
  assert.match(failedCall.statement, /status\s*=\s*'failed'/i);
  assert.deepEqual(failedCall.params, ['upload unavailable', 72, failedObject.objectKey, 123, SHA256]);
  assert.match(verificationCall.statement, /status\s*=\s*'failed'[\s\S]*status\s*=\s*'ready'/i);
  assert.deepEqual(verificationCall.params, ['R2 HEAD mismatch', 71, readyObject.objectKey, 123, SHA256]);
});

test('mediaObjectService: rejects stale or duplicate state transitions that affect no row', async () => {
  const { database } = createDatabaseMock(() => [{ affectedRows: 0 }, []]);
  const service = createMediaObjectService({ database });
  const mediaObject = {
    id: 71,
    objectKey: `articles/88/images/512/${SHA256.slice(0, 12)}-original.jpg`,
    sizeBytes: 123,
    sha256: SHA256,
  };

  await assert.rejects(service.markReady(mediaObject), MediaObjectStateTransitionError);
  await assert.rejects(service.markFailed(mediaObject, new Error('late failure')), MediaObjectStateTransitionError);
  await assert.rejects(service.markVerificationFailed(mediaObject, new Error('late verification failure')), MediaObjectStateTransitionError);
});

test('mediaObjectService: stages every R2 row for idempotent deletion in one locked transaction', async () => {
  const rows = [
    {
      id: 71,
      fileId: 512,
      provider: 'r2',
      variant: 'original',
      objectKey: 'articles/88/images/512/hash-original.jpg',
      localPath: null,
      sizeBytes: 123,
      sha256: SHA256,
      status: 'ready',
    },
    {
      id: 72,
      fileId: 512,
      provider: 'r2',
      variant: 'small',
      objectKey: 'articles/88/images/512/hash-small.jpg',
      localPath: null,
      sizeBytes: 45,
      sha256: SHA256,
      status: 'failed',
    },
  ];
  const { calls, database } = createDatabaseMock((statement) => {
    if (/SELECT[\s\S]+FROM media_object[\s\S]+FOR UPDATE/i.test(statement)) {
      return [rows, []];
    }
    if (/UPDATE media_object[\s\S]+status\s*=\s*'deleting'/i.test(statement)) {
      return [{ affectedRows: 2 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = createMediaObjectService({ database });

  const result = await service.prepareR2Deletion([512, 512]);

  assert.deepEqual(result, rows);
  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.match(executeCalls[0].statement, /provider\s*=\s*'r2'[\s\S]+object_key\s+IS NOT NULL[\s\S]+FOR UPDATE/i);
  assert.deepEqual(executeCalls[0].params, [[512]]);
  assert.match(executeCalls[1].statement, /status\s*=\s*'deleting'/i);
  assert.deepEqual(executeCalls[1].params, [[71, 72]]);
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'begin' }, { type: 'commit' }, { type: 'release' }],
  );
});

test('mediaObjectService: refuses deletion while an upload reservation is still pending', async () => {
  const { calls, database } = createDatabaseMock((statement) => {
    if (/SELECT[\s\S]+FROM media_object[\s\S]+FOR UPDATE/i.test(statement)) {
      return [
        [
          {
            id: 73,
            fileId: 513,
            provider: 'r2',
            variant: 'original',
            objectKey: 'articles/88/images/513/hash-original.jpg',
            localPath: null,
            sizeBytes: 123,
            sha256: SHA256,
            status: 'pending',
          },
        ],
        [],
      ];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  });
  const service = createMediaObjectService({ database });

  await assert.rejects(() => service.prepareR2Deletion([513]), MediaObjectConflictError);

  assert.equal(
    calls.some((call) => call.type === 'execute' && /UPDATE media_object[\s\S]+status\s*=\s*'deleting'/i.test(call.statement)),
    false,
  );
  assert.deepEqual(
    calls.filter((call) => call.type !== 'execute'),
    [{ type: 'begin' }, { type: 'rollback' }, { type: 'release' }],
  );
});
