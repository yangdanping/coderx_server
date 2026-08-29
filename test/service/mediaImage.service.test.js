const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const sharp = require('sharp');
const { createMediaImageService } = require('@/service/mediaImage.service');
const {
  MAX_FLOW_IMAGE_FILE_SIZE,
  MAX_FLOW_IMAGE_PIXELS,
} = require('@/constants/upload');

async function imageBuffer(format, width = 12, height = 8) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 80, b: 140, alpha: 0.75 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

function transaction(overrides = {}) {
  return {
    async beginTransaction() {},
    async execute(statement) {
      if (/INSERT INTO file/i.test(statement)) return [{ insertId: 73, affectedRows: 1 }, []];
      return [{ affectedRows: 1 }, []];
    },
    async commit() {},
    async rollback() {},
    release() {},
    ...overrides,
  };
}

function testDependencies(overrides = {}) {
  const conn = overrides.conn || transaction();
  return {
    database: {
      async getConnection() {
        return conn;
      },
    },
    fsPromises: {
      async mkdir() {},
      async open() {
        return {
          async writeFile() {},
          async close() {},
        };
      },
      async unlink() {},
    },
    imageRoot: '/tmp/coderx-media-image-tests',
    mediaRuntime: {
      async resolveImageUrl(id, { variant }) {
        return `https://media.test/${id}/${variant}`;
      },
      async deleteR2ObjectsForFiles() {
        return { staged: 0, deleted: 0 };
      },
    },
    localMediaCleanup: {
      buildLocalCleanupEntries(rows) {
        return rows.flatMap((row) => [
          { storageArea: 'image', filename: row.filename },
          { storageArea: 'image', filename: row.filename.replace(/\.webp$/, '-small.webp') },
        ]);
      },
      async enqueueInTransaction() {
        return [];
      },
      async processPending() {
        return { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
      },
    },
    randomUUID: () => '123e4567-e89b-12d3-a456-426614174000',
    ...overrides,
  };
}

for (const [format, mimeType] of [
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]) {
  test(`normalizeImage accepts decoded ${format.toUpperCase()} content`, async () => {
    const service = createMediaImageService(testDependencies());
    const normalized = await service.normalizeImage(await imageBuffer(format), mimeType);

    assert.equal(normalized.mimeType, 'image/webp');
    assert.equal(normalized.width, 12);
    assert.equal(normalized.height, 8);
    assert.match(normalized.filename, /^[0-9a-f-]+\.webp$/);
    assert.equal(normalized.smallFilename, normalized.filename.replace(/\.webp$/, '-small.webp'));
    assert.equal((await sharp(normalized.original).metadata()).format, 'webp');
    assert.equal((await sharp(normalized.small).metadata()).format, 'webp');
  });
}

test('normalizeImage rejects active SVG content', async () => {
  const service = createMediaImageService(testDependencies());
  await assert.rejects(
    () => service.normalizeImage(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/jpeg'),
    /JPEG、PNG 或 WebP/,
  );
});

test('normalizeImage rejects forged JPEG content that cannot be decoded', async () => {
  const service = createMediaImageService(testDependencies());
  const forged = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<script>alert(1)</script>')]);
  await assert.rejects(() => service.normalizeImage(forged, 'image/jpeg'), /JPEG、PNG 或 WebP/);
});

test('normalizeImage rejects a 10MB + 1 byte buffer before decode', async () => {
  const service = createMediaImageService(testDependencies({
    sharp() {
      throw new Error('decoder must not run');
    },
  }));
  await assert.rejects(() => service.normalizeImage(Buffer.alloc(MAX_FLOW_IMAGE_FILE_SIZE + 1), 'image/png'), /10MB/);
});

test('normalizeImage rejects 40,000,001 decoded pixels and configures Sharp failOn/pixel cap', async () => {
  const calls = [];
  const service = createMediaImageService(testDependencies({
    sharp(buffer, options) {
      calls.push({ buffer, options });
      return {
        async metadata() {
          return { format: 'png', width: MAX_FLOW_IMAGE_PIXELS + 1, height: 1 };
        },
      };
    },
  }));

  await assert.rejects(() => service.normalizeImage(Buffer.from('decoded-as-png'), 'image/png'), /40,000,000/);
  assert.deepEqual(calls[0].options, { failOn: 'warning', limitInputPixels: MAX_FLOW_IMAGE_PIXELS });
});

test('normalizeImage maps Sharp actual pixel-limit decode failures to the pixel BusinessError', async () => {
  const service = createMediaImageService(testDependencies({
    sharp() {
      return {
        async metadata() {
          throw new Error('Input image exceeds pixel limit');
        },
      };
    },
  }));

  await assert.rejects(
    () => service.normalizeImage(Buffer.from('oversized-png'), 'image/png'),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.httpStatus, 400);
      assert.equal(error.message, '图片像素不能超过 40,000,000');
      return true;
    },
  );
});

test('createPendingImage writes both normalized variants before DB insert and compensates both after DB failure', async () => {
  const calls = [];
  const conn = transaction({
    async beginTransaction() {
      calls.push({ type: 'begin' });
    },
    async execute(statement) {
      calls.push({ type: 'execute', statement });
      throw new Error('database unavailable');
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
    release() {
      calls.push({ type: 'release' });
    },
  });
  const service = createMediaImageService(testDependencies({
    conn,
    fsPromises: {
      async mkdir() {},
      async open(filePath) {
        return {
          async writeFile() {
            calls.push({ type: 'write', filePath });
          },
          async close() {},
        };
      },
      async unlink(filePath) {
        calls.push({ type: 'unlink', filePath });
      },
    },
  }));
  const png = await imageBuffer('png');

  await assert.rejects(
    () => service.createPendingImage(9, { buffer: png, mimetype: 'image/png' }),
    /database unavailable/,
  );

  const writes = calls.filter((call) => call.type === 'write');
  const unlinks = calls.filter((call) => call.type === 'unlink');
  assert.equal(writes.length, 2);
  assert.equal(unlinks.length, 2);
  assert.deepEqual(unlinks.map((call) => call.filePath).sort(), writes.map((call) => call.filePath).sort());
  assert.ok(calls.findIndex((call) => call.type === 'execute') > calls.findLastIndex((call) => call.type === 'write'));
  assert.ok(calls.some((call) => call.type === 'rollback'));
  assert.ok(writes.every((call) => path.dirname(call.filePath) === '/tmp/coderx-media-image-tests'));
});

test('createPendingImage does not unlink a pre-existing asset when the first exclusive open gets EEXIST', async () => {
  const calls = [];
  const exists = Object.assign(new Error('already exists'), { code: 'EEXIST' });
  const service = createMediaImageService(testDependencies({
    fsPromises: {
      async mkdir() {},
      async open(filePath, flags) {
        calls.push({ type: 'open', filePath, flags });
        throw exists;
      },
      async writeFile(filePath) {
        calls.push({ type: 'legacyWrite', filePath });
        throw exists;
      },
      async unlink(filePath) {
        calls.push({ type: 'unlink', filePath });
      },
    },
  }));
  const png = await imageBuffer('png');

  await assert.rejects(
    () => service.createPendingImage(9, { buffer: png, mimetype: 'image/png' }),
    (error) => error.code === 'EEXIST',
  );
  assert.equal(calls.filter((call) => call.type === 'unlink').length, 0);
});

test('createPendingImage compensates only the first owned asset when the second exclusive open gets EEXIST', async () => {
  const calls = [];
  const exists = Object.assign(new Error('already exists'), { code: 'EEXIST' });
  let opened = 0;
  const service = createMediaImageService(testDependencies({
    fsPromises: {
      async mkdir() {},
      async open(filePath, flags) {
        calls.push({ type: 'open', filePath, flags });
        opened += 1;
        if (opened === 2) throw exists;
        return {
          async writeFile() {},
          async close() {
            calls.push({ type: 'close', filePath });
          },
        };
      },
      async writeFile(filePath) {
        calls.push({ type: 'legacyWrite', filePath });
        if (calls.filter((call) => call.type === 'legacyWrite').length === 2) throw exists;
      },
      async unlink(filePath) {
        calls.push({ type: 'unlink', filePath });
      },
    },
  }));
  const png = await imageBuffer('png');

  await assert.rejects(
    () => service.createPendingImage(9, { buffer: png, mimetype: 'image/png' }),
    (error) => error.code === 'EEXIST',
  );
  assert.deepEqual(calls.filter((call) => call.type === 'open').map((call) => call.flags), ['wx', 'wx']);
  assert.deepEqual(
    calls.filter((call) => call.type === 'unlink').map((call) => call.filePath),
    ['/tmp/coderx-media-image-tests/123e4567-e89b-12d3-a456-426614174000.webp'],
  );
});

test('createPendingImage closes and compensates an owned path when writing through its handle fails', async () => {
  const calls = [];
  const writeError = new Error('disk write failed');
  const service = createMediaImageService(testDependencies({
    fsPromises: {
      async mkdir() {},
      async open(filePath, flags) {
        calls.push({ type: 'open', filePath, flags });
        return {
          async writeFile() {
            calls.push({ type: 'handleWrite', filePath });
            throw writeError;
          },
          async close() {
            calls.push({ type: 'close', filePath });
          },
        };
      },
      async writeFile(filePath) {
        calls.push({ type: 'legacyWrite', filePath });
        throw writeError;
      },
      async unlink(filePath) {
        calls.push({ type: 'unlink', filePath });
      },
    },
  }));
  const png = await imageBuffer('png');

  await assert.rejects(
    () => service.createPendingImage(9, { buffer: png, mimetype: 'image/png' }),
    /disk write failed/,
  );
  assert.equal(calls.filter((call) => call.type === 'open').length, 1);
  assert.equal(calls.filter((call) => call.type === 'handleWrite').length, 1);
  assert.equal(calls.filter((call) => call.type === 'close').length, 1);
  assert.deepEqual(
    calls.filter((call) => call.type === 'unlink').map((call) => call.filePath),
    ['/tmp/coderx-media-image-tests/123e4567-e89b-12d3-a456-426614174000.webp'],
  );
});

test('createPendingImage persists real output dimensions and returns the MediaImageAsset contract', async () => {
  const statements = [];
  const conn = transaction({
    async execute(statement, params) {
      statements.push({ statement, params });
      if (/INSERT INTO file/i.test(statement)) return [{ insertId: 73, affectedRows: 1 }, []];
      return [{ affectedRows: 1 }, []];
    },
  });
  const service = createMediaImageService(testDependencies({ conn }));

  const asset = await service.createPendingImage(9, {
    buffer: await imageBuffer('jpeg', 3000, 1500),
    mimetype: 'image/jpeg',
  });

  assert.deepEqual(asset, {
    id: 73,
    url: 'https://media.test/73/original',
    thumbnailUrl: 'https://media.test/73/small',
    mimeType: 'image/webp',
    sizeBytes: asset.sizeBytes,
    width: 2560,
    height: 1280,
  });
  assert.ok(asset.sizeBytes > 0);
  assert.match(statements[0].statement, /INSERT INTO file[\s\S]+RETURNING id/i);
  assert.deepEqual(statements[0].params.slice(0, 2), [9, '123e4567-e89b-12d3-a456-426614174000.webp']);
  assert.deepEqual(statements[0].params.slice(2), ['image/webp', asset.sizeBytes]);
  assert.match(statements[1].statement, /INSERT INTO image_meta/i);
  assert.deepEqual(statements[1].params, [73, 2560, 1280]);
});

test('deletePendingImage is idempotent for a missing image and commits without cleanup', async () => {
  const calls = [];
  const conn = transaction({
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      return [[], []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
  });
  const service = createMediaImageService(testDependencies({ conn }));

  const result = await service.deletePendingImage(9, 73);

  const probe = calls.find((call) => call.type === 'execute');
  assert.match(probe.statement, /SELECT[\s\S]*f\.user_id[\s\S]*WHERE f\.id = \?/i);
  assert.doesNotMatch(probe.statement, /AND f\.user_id = \?/i);
  assert.doesNotMatch(probe.statement, /FOR UPDATE/i);
  assert.deepEqual(probe.params, [73]);
  assert.deepEqual(result, { deleted: false });
  assert.equal(calls.filter((call) => call.type === 'execute').length, 1);
  assert.equal(calls.filter((call) => call.type === 'commit').length, 1);
});

test('deletePendingImage deletes an active owned Flow draft image with draft-first locking and version-preserving metadata update', async () => {
  const calls = [];
  const row = { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: 71, flow_id: null };
  const conn = transaction({
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM file f/i.test(statement) && !/FOR UPDATE/i.test(statement)) return [[row], []];
      if (/FROM draft/i.test(statement)) return [[{ id: 71 }], []];
      if (/FROM file f/i.test(statement) && /FOR UPDATE OF f/i.test(statement)) return [[row], []];
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
  });
  const service = createMediaImageService(testDependencies({ conn }));

  assert.deepEqual(await service.deletePendingImage(9, 73), { deleted: true });

  const statements = calls.filter((call) => call.type === 'execute');
  const probeIndex = statements.findIndex((call) => /FROM file f/i.test(call.statement) && !/FOR UPDATE/i.test(call.statement));
  const draftLockIndex = statements.findIndex((call) => /FROM draft/i.test(call.statement) && /FOR UPDATE/i.test(call.statement));
  const fileLockIndex = statements.findIndex((call) => /FROM file f/i.test(call.statement) && /FOR UPDATE OF f/i.test(call.statement));
  const metaUpdateIndex = statements.findIndex((call) => /^\s*UPDATE draft/i.test(call.statement));
  const deleteIndex = statements.findIndex((call) => /^\s*DELETE FROM file/i.test(call.statement));
  assert.ok(probeIndex < draftLockIndex);
  assert.ok(draftLockIndex < fileLockIndex);
  assert.ok(fileLockIndex < metaUpdateIndex);
  assert.ok(metaUpdateIndex < deleteIndex);
  assert.match(statements[draftLockIndex].statement, /id = \?[\s\S]*user_id = \?[\s\S]*draft_type = 'flow'[\s\S]*article_id IS NULL[\s\S]*status = 'active'[\s\S]*FOR UPDATE/i);
  assert.deepEqual(statements[draftLockIndex].params, [71, 9]);
  assert.match(statements[metaUpdateIndex].statement, /jsonb_set[\s\S]*imageIds[\s\S]*WITH ORDINALITY[\s\S]*jsonb_agg/i);
  assert.doesNotMatch(statements[metaUpdateIndex].statement, /\bversion\b/i);
  assert.deepEqual(statements[metaUpdateIndex].params, [73, 71, 9]);
  assert.match(statements[deleteIndex].statement, /article_id IS NULL[\s\S]*draft_id = \?[\s\S]*NOT EXISTS[\s\S]*flow_post_media/i);
  assert.deepEqual(statements[deleteIndex].params, [73, 9, 71]);
});

test('deletePendingImage rejects a missing, foreign, inactive, or article draft before locking the file', async () => {
  for (const scenario of ['missing', 'foreign', 'inactive', 'article']) {
    const calls = [];
    const row = { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: 71, flow_id: null };
    const conn = transaction({
      async execute(statement, params) {
        calls.push({ statement, params });
        if (/FROM file f/i.test(statement) && !/FOR UPDATE/i.test(statement)) return [[row], []];
        if (/FROM draft/i.test(statement)) return [[], []];
        throw new Error(`unexpected ${scenario} SQL`);
      },
    });
    const service = createMediaImageService(testDependencies({ conn }));

    await assert.rejects(() => service.deletePendingImage(9, 73), /图片不可删除/);

    const draftLock = calls.find((call) => /FROM draft/i.test(call.statement));
    assert.match(draftLock.statement, /id = \?/i);
    assert.match(draftLock.statement, /user_id = \?/i);
    assert.match(draftLock.statement, /draft_type = 'flow'/i);
    assert.match(draftLock.statement, /article_id IS NULL/i);
    assert.match(draftLock.statement, /status = 'active'/i);
    assert.equal(calls.some((call) => /FROM file f/i.test(call.statement) && /FOR UPDATE/i.test(call.statement)), false);
  }
});

test('deletePendingImage revalidates the locked draft image after a modeled concurrent autosave interleaving', async () => {
  const calls = [];
  const probed = { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: 71, flow_id: null };
  const changed = { ...probed, draft_id: 72 };
  const conn = transaction({
    async execute(statement, params) {
      calls.push({ statement, params });
      if (/FROM file f/i.test(statement) && !/FOR UPDATE/i.test(statement)) return [[probed], []];
      if (/FROM draft/i.test(statement)) return [[{ id: 71 }], []];
      if (/FROM file f/i.test(statement) && /FOR UPDATE OF f/i.test(statement)) return [[changed], []];
      throw new Error('metadata or deletion must not run');
    },
  });
  const service = createMediaImageService(testDependencies({ conn }));

  await assert.rejects(() => service.deletePendingImage(9, 73), /图片不可删除/);

  const draftLockIndex = calls.findIndex((call) => /FROM draft/i.test(call.statement));
  const fileLockIndex = calls.findIndex((call) => /FROM file f/i.test(call.statement) && /FOR UPDATE OF f/i.test(call.statement));
  assert.notEqual(draftLockIndex, -1);
  assert.notEqual(fileLockIndex, -1);
  assert.ok(draftLockIndex < fileLockIndex);
  assert.equal(calls.some((call) => /^\s*UPDATE draft/i.test(call.statement)), false);
  assert.equal(calls.some((call) => /^\s*DELETE FROM file/i.test(call.statement)), false);
});

test('deletePendingImage rejects locked article-bound or published Flow media', async () => {
  for (const lockedRow of [
    { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: 5, draft_id: null, flow_id: null },
    { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: null, flow_id: 7 },
  ]) {
    let selects = 0;
    const conn = transaction({
      async execute(statement) {
        if (/FROM file f/i.test(statement)) {
          selects += 1;
          return [[lockedRow], []];
        }
        throw new Error('mutation must not run');
      },
    });
    const service = createMediaImageService(testDependencies({ conn }));
    await assert.rejects(() => service.deletePendingImage(9, 73), /图片不可删除/);
    assert.equal(selects, 2);
  }
});

test('deletePendingImage rejects an existing foreign-owned image with a 403 BusinessError', async () => {
  const calls = [];
  const foreignRow = { id: 73, user_id: 10, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: null, flow_id: null };
  const conn = transaction({
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM file f/i.test(statement) && !/FOR UPDATE/i.test(statement)) return [[foreignRow], []];
      throw new Error('foreign image rejection must not acquire locks or mutate');
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
  });
  const service = createMediaImageService(testDependencies({ conn }));

  await assert.rejects(
    () => service.deletePendingImage(9, 73),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.httpStatus, 403);
      assert.equal(error.message, '图片不可删除');
      return true;
    },
  );

  assert.equal(calls.filter((call) => call.type === 'execute').length, 1);
  assert.equal(calls.filter((call) => call.type === 'rollback').length, 1);
});

test('deletePendingImage stages R2/local cleanup, deletes, commits, then consumes local outbox', async () => {
  const calls = [];
  const row = { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: null, flow_id: null };
  const conn = transaction({
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/^\s*SELECT/i.test(statement)) return [[row], []];
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
    },
  });
  const deps = testDependencies({ conn });
  deps.mediaRuntime = {
    async resolveImageUrl() {},
    async deleteR2ObjectsForFiles(ids) {
      calls.push({ type: 'r2', ids });
    },
  };
  deps.localMediaCleanup = {
    buildLocalCleanupEntries(rows) {
      calls.push({ type: 'buildCleanup', rows });
      return [{ storageArea: 'image', filename: 'a.webp' }];
    },
    async enqueueInTransaction(transactionConnection, entries) {
      calls.push({ type: 'enqueue', transactionConnection, entries });
      return [801];
    },
    async processPending(payload) {
      calls.push({ type: 'process', payload });
      return { examined: 1, deleted: 1, missing: 0, failed: 0, pendingIds: [] };
    },
  };
  const service = createMediaImageService(deps);

  assert.deepEqual(await service.deletePendingImage(9, 73), { deleted: true });

  const index = (type) => calls.findIndex((call) => call.type === type);
  const deleteIndex = calls.findIndex((call) => call.type === 'execute' && /^\s*DELETE/i.test(call.statement));
  assert.ok(index('r2') < index('enqueue'));
  assert.ok(index('enqueue') < deleteIndex);
  assert.ok(deleteIndex < index('commit'));
  assert.ok(index('commit') < index('process'));
});

test('deletePendingImage rolls back a draft metadata update and file deletion when commit fails without running local cleanup', async () => {
  const calls = [];
  const row = { id: 73, user_id: 9, filename: 'a.webp', file_type: 'image', article_id: null, draft_id: 71, flow_id: null };
  const conn = transaction({
    async execute(statement, params) {
      calls.push({ type: 'execute', statement, params });
      if (/FROM file f/i.test(statement)) return [[row], []];
      if (/FROM draft/i.test(statement)) return [[{ id: 71 }], []];
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      calls.push({ type: 'commit' });
      throw new Error('database commit failed');
    },
    async rollback() {
      calls.push({ type: 'rollback' });
    },
  });
  const deps = testDependencies({ conn });
  deps.localMediaCleanup = {
    buildLocalCleanupEntries(rows) {
      calls.push({ type: 'buildCleanup', rows });
      return [{ storageArea: 'image', filename: 'a.webp' }];
    },
    async enqueueInTransaction(_transactionConnection, entries) {
      calls.push({ type: 'enqueue', entries });
      return [801];
    },
    async processPending(payload) {
      calls.push({ type: 'process', payload });
    },
  };
  const service = createMediaImageService(deps);

  await assert.rejects(() => service.deletePendingImage(9, 73), /database commit failed/);

  assert.equal(calls.filter((call) => call.type === 'rollback').length, 1);
  assert.equal(calls.some((call) => call.type === 'process'), false);
  assert.ok(calls.some((call) => call.type === 'execute' && /^\s*UPDATE draft/i.test(call.statement)));
  assert.ok(calls.some((call) => call.type === 'execute' && /^\s*DELETE FROM file/i.test(call.statement)));
});
