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
    async markReady(id) {
      calls.push({ type: 'ready', id });
    },
    async markFailed(id, error) {
      calls.push({ type: 'failed', id, error });
    },
  };
  const r2Store = {
    async put(payload) {
      let uploaded = Buffer.alloc(0);
      for await (const chunk of payload.body) uploaded = Buffer.concat([uploaded, chunk]);
      calls.push({ type: 'put', payload: { ...payload, body: uploaded } });
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
  assert.deepEqual(calls[1].payload.body, contents);
  assert.deepEqual(calls.slice(2), [
    { type: 'head', key: expectedKey },
    { type: 'ready', id: 71 },
  ]);
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
      async markFailed(id, error) {
        failures.push({ id, error });
      },
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
  assert.equal(failures[0].id, 71);
  assert.match(failures[0].error.message, /HEAD|verification|校验/i);
  assert.deepEqual(await fs.readFile(localPath), contents);
});
