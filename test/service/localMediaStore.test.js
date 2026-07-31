const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

require('module-alias/register');

const { createLocalMediaStore } = require('@/storage/localMediaStore');

async function makeStore(t) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-local-media-'));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  return {
    rootPath,
    store: createLocalMediaStore({
      rootPath,
      publicBaseUrl: 'https://api.example/article/media',
    }),
  };
}

test('LocalMediaStore: put atomically writes content and head returns verified metadata', async (t) => {
  const { rootPath, store } = await makeStore(t);
  const key = 'articles/88/images/512/9f4a28d195ac-original.jpg';
  const body = Buffer.from('immutable local content');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  const stored = await store.put({
    key,
    body,
    contentType: 'image/jpeg',
    sizeBytes: body.length,
    sha256,
  });

  assert.deepEqual(stored, {
    key,
    sizeBytes: body.length,
    sha256,
    etag: null,
  });
  assert.equal(await fs.readFile(path.join(rootPath, key), 'utf8'), body.toString());
  assert.deepEqual(await store.head(key), stored);

  const directoryEntries = await fs.readdir(path.dirname(path.join(rootPath, key)));
  assert.deepEqual(directoryEntries, [path.basename(key)]);
});

test('LocalMediaStore: delete is idempotent and publicUrl joins encoded keys', async (t) => {
  const { store } = await makeStore(t);
  const key = 'articles/88/images/512/hash-small.jpg';
  const body = Buffer.from('small');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  await store.put({ key, body, sizeBytes: body.length, sha256 });
  await store.delete(key);
  await store.delete(key);

  assert.equal(await store.head(key), null);
  assert.equal(store.publicUrl('articles/88/images/512/hash small.jpg'), 'https://api.example/article/media/articles/88/images/512/hash%20small.jpg');
});

test('LocalMediaStore: every operation rejects keys that escape the configured root', async (t) => {
  const { rootPath, store } = await makeStore(t);
  const outsidePath = path.join(rootPath, '..', 'escaped.txt');

  await assert.rejects(
    store.put({
      key: '../escaped.txt',
      body: Buffer.from('escape'),
      sizeBytes: 6,
      sha256: crypto.createHash('sha256').update('escape').digest('hex'),
    }),
    /root|key|path|escape/i,
  );
  await assert.rejects(store.head('../escaped.txt'), /root|key|path|escape/i);
  await assert.rejects(store.delete('../escaped.txt'), /root|key|path|escape/i);
  assert.throws(() => store.publicUrl('../escaped.txt'), /root|key|path|escape/i);
  await assert.rejects(fs.access(outsidePath));
});

test('LocalMediaStore: rejects a symlinked parent that escapes the configured root', async (t) => {
  const { rootPath, store } = await makeStore(t);
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-local-media-outside-'));
  t.after(() => fs.rm(outsideDirectory, { recursive: true, force: true }));
  await fs.symlink(outsideDirectory, path.join(rootPath, 'linked'));

  const body = Buffer.from('must stay inside');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  await assert.rejects(
    store.put({
      key: 'linked/escaped.jpg',
      body,
      sizeBytes: body.length,
      sha256,
    }),
    /symlink|symbolic|root|escape/i,
  );
  await assert.rejects(fs.access(path.join(outsideDirectory, 'escaped.jpg')));
});

test('LocalMediaStore: concurrent writers cannot overwrite the immutable destination', async (t) => {
  const { rootPath, store } = await makeStore(t);
  const key = 'articles/88/images/512/concurrent-original.jpg';
  const firstBody = Buffer.from('first immutable payload');
  const secondBody = Buffer.from('second immutable value');
  let releaseStreams;
  const streamGate = new Promise((resolve) => {
    releaseStreams = resolve;
  });
  const gatedStream = (body) =>
    Readable.from(
      (async function* generate() {
        await streamGate;
        yield body;
      })(),
    );

  const firstPut = store.put({
    key,
    body: gatedStream(firstBody),
    sizeBytes: firstBody.length,
    sha256: crypto.createHash('sha256').update(firstBody).digest('hex'),
  });
  const secondPut = store.put({
    key,
    body: gatedStream(secondBody),
    sizeBytes: secondBody.length,
    sha256: crypto.createHash('sha256').update(secondBody).digest('hex'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseStreams();

  const results = await Promise.allSettled([firstPut, secondPut]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /conflict|overwrite|exists/i);

  const storedBody = await fs.readFile(path.join(rootPath, key));
  assert.equal(storedBody.equals(firstBody) || storedBody.equals(secondBody), true);
});

test('LocalMediaStore: rejects group/world-writable parents outside the trusted service boundary', async (t) => {
  const { rootPath, store } = await makeStore(t);
  const unsafeParent = path.join(rootPath, 'unsafe');
  await fs.mkdir(unsafeParent);
  await fs.chmod(unsafeParent, 0o777);
  t.after(() => fs.chmod(unsafeParent, 0o700).catch(() => {}));

  const body = Buffer.from('trusted-root-only');
  await assert.rejects(
    store.put({
      key: 'unsafe/object.jpg',
      body,
      sizeBytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    }),
    /permission|writable|trusted|owner/i,
  );
});
