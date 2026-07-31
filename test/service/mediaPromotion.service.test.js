const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('module-alias/register');

const { IMMUTABLE_CACHE_CONTROL } = require('@/constants/mediaStorage');
const { createMediaPromotionService } = require('@/service/mediaPromotion.service');

async function createLocalFixture(t, contents = 'promotion payload') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-promotion-'));
  const localPath = path.join(directory, 'cover.jpg');
  await fs.writeFile(localPath, contents);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { contents: Buffer.from(contents), localPath };
}

test('mediaPromotionService: hashes local content, uploads, verifies HEAD and marks ready while retaining local', async (t) => {
  const { contents, localPath } = await createLocalFixture(t);
  const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
  const calls = [];
  const mediaObjectService = {
    async reserveR2Object(payload) {
      calls.push({ type: 'reserve', payload });
      return {
        reserved: true,
        mediaObject: { id: 71, ...payload, status: 'pending' },
      };
    },
    async markReady(mediaObject) {
      calls.push({ type: 'ready', mediaObject });
      return { affectedRows: 1 };
    },
    async markFailed(mediaObject, error) {
      calls.push({ type: 'failed', mediaObject, error });
      return { affectedRows: 1 };
    },
  };
  const r2Store = {
    async put(payload) {
      let uploaded = Buffer.alloc(0);
      for await (const chunk of payload.bodyFactory()) uploaded = Buffer.concat([uploaded, chunk]);
      calls.push({ type: 'put', payload: { ...payload, bodyFactory: true, body: uploaded } });
      return {
        key: payload.key,
        sizeBytes: payload.sizeBytes,
        sha256: payload.sha256,
        etag: '"etag"',
        skipped: false,
      };
    },
    async head(key) {
      calls.push({ type: 'head', key });
      return { key, sizeBytes: contents.length, sha256, etag: '"etag"' };
    },
  };
  const service = createMediaPromotionService({ mediaObjectService, r2Store });

  const result = await service.promote({
    articleId: 88,
    fileId: 512,
    variant: 'original',
    localPath,
    contentType: 'image/jpeg',
  });

  const expectedKey = `articles/88/images/512/${sha256.slice(0, 12)}-original.jpg`;
  assert.deepEqual(calls[0], {
    type: 'reserve',
    payload: {
      fileId: 512,
      variant: 'original',
      objectKey: expectedKey,
      sizeBytes: contents.length,
      sha256,
    },
  });
  assert.equal(calls[1].type, 'put');
  assert.equal(calls[1].payload.key, expectedKey);
  assert.equal(calls[1].payload.contentType, 'image/jpeg');
  assert.equal(calls[1].payload.cacheControl, IMMUTABLE_CACHE_CONTROL);
  assert.equal(calls[1].payload.contentMd5, crypto.createHash('md5').update(contents).digest('base64'));
  assert.equal(calls[1].payload.bodyFactory, true);
  assert.deepEqual(calls[1].payload.body, contents);
  assert.deepEqual(calls.slice(2, 3), [{ type: 'head', key: expectedKey }]);
  assert.equal(calls[3].type, 'ready');
  assert.deepEqual(calls[3].mediaObject, {
    id: 71,
    fileId: 512,
    variant: 'original',
    objectKey: expectedKey,
    sizeBytes: contents.length,
    sha256,
    status: 'pending',
  });
  assert.deepEqual(result, {
    key: expectedKey,
    sizeBytes: contents.length,
    sha256,
    etag: '"etag"',
    skipped: false,
    retainedLocal: true,
  });
  assert.deepEqual(await fs.readFile(localPath), contents);
});

test('mediaPromotionService: matching ready object is idempotently skipped after HEAD verification', async (t) => {
  const { contents, localPath } = await createLocalFixture(t);
  const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
  let putCalled = false;
  let markReadyCalled = false;
  const service = createMediaPromotionService({
    mediaObjectService: {
      async reserveR2Object(payload) {
        return {
          reserved: false,
          mediaObject: { id: 71, ...payload, status: 'ready' },
        };
      },
      async markReady() {
        markReadyCalled = true;
      },
      async markFailed() {},
      async markVerificationFailed() {},
    },
    r2Store: {
      async put() {
        putCalled = true;
      },
      async head(key) {
        return { key, sizeBytes: contents.length, sha256, etag: '"existing"' };
      },
    },
  });

  const result = await service.promote({
    articleId: 88,
    fileId: 512,
    variant: 'original',
    localPath,
    contentType: 'image/jpeg',
  });

  assert.equal(result.skipped, true);
  assert.equal(result.etag, '"existing"');
  assert.equal(result.retainedLocal, true);
  assert.equal(putCalled, false);
  assert.equal(markReadyCalled, false);
  assert.deepEqual(await fs.readFile(localPath), contents);
});

test('mediaPromotionService: failed HEAD verification marks failed and never deletes local content', async (t) => {
  const { contents, localPath } = await createLocalFixture(t);
  const failures = [];
  const service = createMediaPromotionService({
    mediaObjectService: {
      async reserveR2Object(payload) {
        return {
          reserved: true,
          mediaObject: { id: 71, ...payload, status: 'pending' },
        };
      },
      async markReady() {
        throw new Error('must not mark ready');
      },
      async markFailed(mediaObject, error) {
        failures.push({ mediaObject, error });
        return { affectedRows: 1 };
      },
      async markVerificationFailed() {},
    },
    r2Store: {
      async put(payload) {
        return { ...payload, etag: '"etag"', skipped: false };
      },
      async head(key) {
        return { key, sizeBytes: contents.length + 1, sha256: '0'.repeat(64), etag: '"bad"' };
      },
    },
  });

  await assert.rejects(
    service.promote({
      articleId: 88,
      fileId: 512,
      variant: 'original',
      localPath,
      contentType: 'image/jpeg',
    }),
    /HEAD|verification|校验/i,
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0].mediaObject.id, 71);
  assert.match(failures[0].error.message, /HEAD|verification|校验/i);
  assert.deepEqual(await fs.readFile(localPath), contents);
});

test('mediaPromotionService: matching pending reservation is in progress and never uploads twice', async (t) => {
  const { contents, localPath } = await createLocalFixture(t);
  const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
  let putCalled = false;
  const service = createMediaPromotionService({
    mediaObjectService: {
      async reserveR2Object(payload) {
        return {
          reserved: false,
          mediaObject: { id: 71, ...payload, status: 'pending' },
        };
      },
      async markReady() {},
      async markFailed() {},
      async markVerificationFailed() {},
    },
    r2Store: {
      async put() {
        putCalled = true;
      },
      async head() {
        throw new Error('pending retry must not inspect or upload R2');
      },
    },
  });

  const result = await service.promote({
    articleId: 88,
    fileId: 512,
    variant: 'original',
    localPath,
    contentType: 'image/jpeg',
  });

  assert.equal(putCalled, false);
  assert.equal(result.inProgress, true);
  assert.equal(result.skipped, true);
  assert.equal(result.sha256, sha256);
  assert.deepEqual(await fs.readFile(localPath), contents);
});

test('mediaPromotionService: a conflicting ready object is demoted and never served as ready', async (t) => {
  const { contents, localPath } = await createLocalFixture(t);
  const demotions = [];
  let putCalled = false;
  const service = createMediaPromotionService({
    mediaObjectService: {
      async reserveR2Object(payload) {
        return {
          reserved: false,
          mediaObject: { id: 71, ...payload, status: 'ready' },
        };
      },
      async markReady() {},
      async markFailed() {},
      async markVerificationFailed(mediaObject, error) {
        demotions.push({ mediaObject, error });
        return { affectedRows: 1 };
      },
    },
    r2Store: {
      async put() {
        putCalled = true;
      },
      async head(key) {
        return { key, sizeBytes: contents.length, sha256: '0'.repeat(64), etag: '"conflict"' };
      },
    },
  });

  await assert.rejects(
    service.promote({
      articleId: 88,
      fileId: 512,
      variant: 'original',
      localPath,
      contentType: 'image/jpeg',
    }),
    /conflict|verification|HEAD/i,
  );

  assert.equal(putCalled, false);
  assert.equal(demotions.length, 1);
  assert.equal(demotions[0].mediaObject.status, 'ready');
});

test('mediaPromotionService: uploads a stable snapshot if the source changes after hashing', async (t) => {
  const { contents, localPath } = await createLocalFixture(t, 'original bytes');
  const replacement = Buffer.from('modified bytes');
  assert.equal(replacement.length, contents.length);
  const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
  let uploaded;
  const service = createMediaPromotionService({
    mediaObjectService: {
      async reserveR2Object(payload) {
        await fs.writeFile(localPath, replacement);
        return {
          reserved: true,
          mediaObject: { id: 71, ...payload, status: 'pending' },
        };
      },
      async markReady() {
        return { affectedRows: 1 };
      },
      async markFailed() {
        return { affectedRows: 1 };
      },
      async markVerificationFailed() {
        return { affectedRows: 1 };
      },
    },
    r2Store: {
      async put(payload) {
        uploaded = Buffer.alloc(0);
        for await (const chunk of payload.bodyFactory()) uploaded = Buffer.concat([uploaded, chunk]);
        assert.equal(payload.contentMd5, crypto.createHash('md5').update(contents).digest('base64'));
        return { key: payload.key, sizeBytes: payload.sizeBytes, sha256: payload.sha256, etag: '"etag"', skipped: false };
      },
      async head(key) {
        return { key, sizeBytes: contents.length, sha256, etag: '"etag"' };
      },
    },
  });

  await service.promote({
    articleId: 88,
    fileId: 512,
    variant: 'original',
    localPath,
    contentType: 'image/jpeg',
  });

  assert.deepEqual(uploaded, contents);
  assert.deepEqual(await fs.readFile(localPath), replacement);
});

test('mediaPromotionService: invalid key input still cleans the prepared snapshot', async () => {
  let cleaned = false;
  const service = createMediaPromotionService({
    snapshotFactory: async () => ({
      snapshotPath: '/tmp/not-opened',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      contentMd5: 'md5',
      async cleanup() {
        cleaned = true;
      },
    }),
    mediaObjectService: {
      async reserveR2Object() {
        throw new Error('reservation must not run for an invalid key');
      },
    },
    r2Store: {
      async put() {},
      async head() {},
    },
  });

  await assert.rejects(
    service.promote({
      articleId: 0,
      fileId: 512,
      variant: 'original',
      localPath: '/unused',
      contentType: 'image/jpeg',
    }),
    /articleId|positive/i,
  );
  assert.equal(cleaned, true);
});
