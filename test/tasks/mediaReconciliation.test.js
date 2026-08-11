const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { reconcileR2Media } = require('@/tasks/reconcileR2Media');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function candidate(fileId, sha256, variant = 'original') {
  return {
    articleId: 7,
    fileId,
    fileType: 'image',
    variant,
    localPath: `/srv/coderx/public/img/${fileId}.jpg`,
    filename: `${fileId}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 10,
    testSha256: sha256,
  };
}

function catalogFixture(candidates) {
  return {
    async listPublishedFiles() {
      return candidates.map((item) => ({ id: item.fileId, articleId: item.articleId }));
    },
    async discoverVariants() {
      return { candidates, missingAssets: [], optionalMissingAssets: [], invalidRows: [] };
    },
  };
}

function row({ id, fileId, provider, variant = 'original', status, sha256, objectKey = null, localPath = null, updatedAt }) {
  return { id, fileId, provider, variant, status, sha256, sizeBytes: 10, objectKey, localPath, updatedAt };
}

test('reconciliation read-only reports local/R2 mismatches and paginated orphan objects without mutation', async () => {
  const candidates = [candidate(11, SHA_A), candidate(12, SHA_B)];
  const rows = [
    row({ id: 1, fileId: 11, provider: 'local', status: 'ready', sha256: SHA_A, localPath: candidates[0].localPath }),
    row({ id: 2, fileId: 11, provider: 'r2', status: 'ready', sha256: SHA_A, objectKey: 'articles/7/images/11/a-original.jpg' }),
    row({ id: 3, fileId: 12, provider: 'local', status: 'ready', sha256: SHA_C, localPath: candidates[1].localPath }),
  ];
  const mutations = [];
  let listPage = 0;
  const report = await reconcileR2Media({
    catalog: catalogFixture(candidates),
    database: {
      async execute() {
        return [rows, []];
      },
    },
    inspector: async (localPath) => ({ sizeBytes: 10, sha256: localPath.endsWith('/11.jpg') ? SHA_A : SHA_B }),
    mediaObjectService: {
      async markReady(value) {
        mutations.push(['ready', value.id]);
      },
      async markFailed(value) {
        mutations.push(['failed', value.id]);
      },
      async markVerificationFailed(value) {
        mutations.push(['verification', value.id]);
      },
    },
    r2Store: {
      async head(key) {
        return key.includes('/11/') ? { key, sizeBytes: 10, sha256: SHA_C } : null;
      },
      async list({ continuationToken }) {
        listPage += 1;
        if (!continuationToken) {
          return {
            objects: [
              { key: 'articles/7/images/11/a-original.jpg', sizeBytes: 10 },
              { key: 'orphan/one.jpg', sizeBytes: 3 },
            ],
            continuationToken: 'next',
          };
        }
        return { objects: [{ key: 'orphan/two.jpg', sizeBytes: 4 }], continuationToken: null };
      },
      async delete() {
        throw new Error('reconciliation must never delete');
      },
    },
    repair: false,
  });

  assert.equal(listPage, 2);
  assert.deepEqual(mutations, []);
  assert.deepEqual(report.r2ObjectsWithoutDatabase, [
    { key: 'orphan/one.jpg', sizeBytes: 3 },
    { key: 'orphan/two.jpg', sizeBytes: 4 },
  ]);
  assert.equal(
    report.issues.some((issue) => issue.code === 'R2_HEAD_MISMATCH' && issue.fileId === 11),
    true,
  );
  assert.equal(
    report.issues.some((issue) => issue.code === 'LOCAL_ROW_MISMATCH' && issue.fileId === 12),
    true,
  );
  assert.equal(
    report.issues.some((issue) => issue.code === 'R2_ROW_MISSING' && issue.fileId === 12),
    true,
  );
  assert.equal(report.repaired, 0);
});

test('reconciliation repair resolves only stale pending/invalid ready states and preserves fresh pending', async () => {
  const candidates = [candidate(21, SHA_A), candidate(22, SHA_B), candidate(23, SHA_C), candidate(24, SHA_A)];
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const fresh = new Date();
  const rows = [
    row({ id: 21, fileId: 21, provider: 'r2', status: 'pending', sha256: SHA_A, objectKey: 'key/21', updatedAt: stale }),
    row({ id: 22, fileId: 22, provider: 'r2', status: 'pending', sha256: SHA_B, objectKey: 'key/22', updatedAt: stale }),
    row({ id: 23, fileId: 23, provider: 'r2', status: 'pending', sha256: SHA_C, objectKey: 'key/23', updatedAt: fresh }),
    row({ id: 24, fileId: 24, provider: 'r2', status: 'ready', sha256: SHA_A, objectKey: 'key/24', updatedAt: stale }),
  ];
  const calls = [];
  const report = await reconcileR2Media({
    catalog: catalogFixture(candidates),
    database: {
      async execute() {
        return [rows, []];
      },
    },
    inspector: async (localPath) => ({
      sizeBytes: 10,
      sha256: candidates.find((item) => item.localPath === localPath).testSha256,
    }),
    mediaObjectService: {
      async markReady(value) {
        calls.push(['ready', value.id]);
      },
      async markFailed(value) {
        calls.push(['failed', value.id]);
      },
      async markVerificationFailed(value) {
        calls.push(['verification', value.id]);
      },
    },
    r2Store: {
      async head(key) {
        if (key === 'key/21') return { key, sizeBytes: 10, sha256: SHA_A };
        if (key === 'key/24') return null;
        return null;
      },
      async list() {
        return { objects: [], continuationToken: null };
      },
      async delete() {
        throw new Error('reconciliation must never delete');
      },
    },
    repair: true,
    pendingOlderThanMs: 60 * 60 * 1000,
  });

  assert.deepEqual(calls, [
    ['ready', 21],
    ['failed', 22],
    ['verification', 24],
  ]);
  assert.equal(report.repaired, 3);
  assert.equal(
    report.issues.some((issue) => issue.code === 'R2_PENDING_FRESH' && issue.fileId === 23),
    true,
  );
});

test('reconciliation never restores R2 content that no longer matches the current local file', async () => {
  const candidates = [candidate(31, SHA_A), candidate(32, SHA_A)];
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const rows = [
    row({ id: 31, fileId: 31, provider: 'r2', status: 'pending', sha256: SHA_B, objectKey: 'key/31', updatedAt: stale }),
    row({ id: 32, fileId: 32, provider: 'r2', status: 'ready', sha256: SHA_B, objectKey: 'key/32', updatedAt: stale }),
  ];
  const calls = [];

  await reconcileR2Media({
    catalog: catalogFixture(candidates),
    database: {
      async execute() {
        return [rows, []];
      },
    },
    inspector: async () => ({ sizeBytes: 10, sha256: SHA_A }),
    mediaObjectService: {
      async markReady(value) {
        calls.push(['ready', value.id]);
      },
      async markFailed(value) {
        calls.push(['failed', value.id]);
      },
      async markVerificationFailed(value) {
        calls.push(['verification', value.id]);
      },
    },
    r2Store: {
      async head(key) {
        return { key, sizeBytes: 10, sha256: SHA_B };
      },
      async list() {
        return { objects: [], continuationToken: null };
      },
    },
    repair: true,
    pendingOlderThanMs: 60 * 60 * 1000,
  });

  assert.deepEqual(calls, [
    ['failed', 31],
    ['verification', 32],
  ]);
});

test('partial reconciliation does not misclassify media rows from other batches', async () => {
  const selected = candidate(41, SHA_A);
  const rows = [
    row({ id: 41, fileId: 41, provider: 'r2', status: 'ready', sha256: SHA_A, objectKey: 'key/41' }),
    row({ id: 99, fileId: 99, provider: 'r2', status: 'ready', sha256: SHA_B, objectKey: 'key/99' }),
  ];
  const report = await reconcileR2Media({
    catalog: catalogFixture([selected]),
    database: {
      async execute() {
        return [rows, []];
      },
    },
    inspector: async () => ({ sizeBytes: 10, sha256: SHA_A }),
    mediaObjectService: {
      async markReady() {},
      async markFailed() {},
      async markVerificationFailed() {},
    },
    r2Store: {
      async head(key) {
        return { key, sizeBytes: 10, sha256: SHA_A };
      },
      async list() {
        return {
          objects: [
            { key: 'key/41', sizeBytes: 10 },
            { key: 'key/99', sizeBytes: 10 },
          ],
          continuationToken: null,
        };
      },
    },
    articleId: 7,
    limit: 1,
  });

  assert.equal(report.scopeCoverageComplete, false);
  assert.deepEqual(report.databaseRowsWithoutPublishedMedia, []);
  assert.deepEqual(report.r2ObjectsWithoutDatabase, []);
});

test('reconciliation recognizes a verified R2 fallback when the required local file is missing', async () => {
  const r2Row = row({
    id: 51,
    fileId: 51,
    provider: 'r2',
    status: 'ready',
    sha256: SHA_A,
    objectKey: 'articles/7/images/51/a-original.jpg',
  });
  const report = await reconcileR2Media({
    catalog: {
      async listPublishedFiles() {
        return [{ id: 51, articleId: 7 }];
      },
      async discoverVariants() {
        return {
          candidates: [],
          missingAssets: [{ fileId: 51, articleId: 7, variant: 'original' }],
          optionalMissingAssets: [],
          invalidRows: [],
        };
      },
    },
    database: {
      async execute() {
        return [[r2Row], []];
      },
    },
    mediaObjectService: {
      async markReady() {},
      async markFailed() {},
      async markVerificationFailed() {},
    },
    r2Store: {
      async head(key) {
        return { key, sizeBytes: 10, sha256: SHA_A };
      },
      async list() {
        return { objects: [{ key: r2Row.objectKey, sizeBytes: 10 }], continuationToken: null };
      },
    },
  });

  assert.equal(
    report.issues.some((item) => item.code === 'LOCAL_FILE_MISSING_R2_READY' && item.fileId === 51),
    true,
  );
  assert.deepEqual(report.databaseRowsWithoutPublishedMedia, []);
  assert.deepEqual(report.r2ObjectsWithoutDatabase, []);
});

test('reconciliation detects and repairs a stale pending neutral Flow object with Flow identity', async () => {
  const flowCandidate = { ...candidate(61, SHA_A), articleId: null, flowId: 91 };
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const r2Row = row({ id: 61, fileId: 61, provider: 'r2', status: 'pending', sha256: SHA_A, objectKey: 'media/images/61/hash-original.jpg', updatedAt: stale });
  const calls = [];

  const report = await reconcileR2Media({
    catalog: catalogFixture([flowCandidate]),
    database: {
      async execute() {
        return [[r2Row], []];
      },
    },
    inspector: async () => ({ sizeBytes: 10, sha256: SHA_A }),
    mediaObjectService: {
      async markReady(value) {
        calls.push(['ready', value.id]);
      },
      async markFailed(value) {
        calls.push(['failed', value.id]);
      },
      async markVerificationFailed(value) {
        calls.push(['verification', value.id]);
      },
    },
    r2Store: {
      async head(key) {
        return { key, sizeBytes: 10, sha256: SHA_A };
      },
      async list() {
        return { objects: [{ key: r2Row.objectKey, sizeBytes: 10 }], continuationToken: null };
      },
    },
    repair: true,
    pendingOlderThanMs: 60 * 60 * 1000,
  });

  assert.deepEqual(calls, [['ready', 61]]);
  assert.equal(report.repaired, 1);
  assert.equal(
    report.issues.some((item) => item.code === 'R2_PENDING_STALE_MATCH' && item.fileId === 61 && item.flowId === 91),
    true,
  );
  assert.deepEqual(report.databaseRowsWithoutPublishedMedia, []);
});
