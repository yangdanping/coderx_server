const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

require('module-alias/register');

const { IMMUTABLE_CACHE_CONTROL } = require('@/constants/mediaStorage');
const { createR2MediaStore } = require('@/storage/r2MediaStore');

function commandName(command) {
  return command.constructor.name;
}

function createClient(handler) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return handler(command, calls);
    },
  };
}

const sha256 = crypto.createHash('sha256').update('r2 store fixture').digest('hex');
const key = `articles/88/images/512/${sha256.slice(0, 12)}-original.jpg`;

test('R2MediaStore: put writes immutable cache-control and sha256 metadata, then head normalizes the object', async () => {
  const client = createClient((command) => {
    if (commandName(command) === 'HeadObjectCommand') {
      const error = new Error('missing');
      error.name = 'NotFound';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    if (commandName(command) === 'PutObjectCommand') {
      return { ETag: '"etag-value"' };
    }
    throw new Error(`Unexpected command: ${commandName(command)}`);
  });
  const store = createR2MediaStore({
    client,
    bucket: 'coderx-media-public',
    publicBaseUrl: 'https://media.ydp321.asia',
  });
  const body = Buffer.from('image bytes');
  const contentMd5 = crypto.createHash('md5').update(body).digest('base64');

  const result = await store.put({
    key,
    body,
    contentType: 'image/jpeg',
    sizeBytes: body.length,
    sha256,
    contentMd5,
  });

  assert.equal(commandName(client.calls[0]), 'HeadObjectCommand');
  assert.equal(commandName(client.calls[1]), 'PutObjectCommand');
  assert.deepEqual(client.calls[1].input, {
    Bucket: 'coderx-media-public',
    Key: key,
    Body: body,
    ContentType: 'image/jpeg',
    ContentLength: body.length,
    CacheControl: IMMUTABLE_CACHE_CONTROL,
    ContentMD5: contentMd5,
    IfNoneMatch: '*',
    Metadata: { sha256 },
  });
  assert.deepEqual(result, {
    key,
    sizeBytes: body.length,
    sha256,
    etag: '"etag-value"',
    skipped: false,
  });
});

test('R2MediaStore: head returns metadata and maps missing objects to null', async () => {
  let missing = false;
  const client = createClient((command) => {
    assert.equal(commandName(command), 'HeadObjectCommand');
    if (missing) {
      const error = new Error('missing');
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    return {
      ContentLength: 123,
      Metadata: { sha256 },
      ETag: '"head-etag"',
    };
  });
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example/' });

  assert.deepEqual(await store.head(key), {
    key,
    sizeBytes: 123,
    sha256,
    etag: '"head-etag"',
  });
  missing = true;
  assert.equal(await store.head(key), null);
});

test('R2MediaStore: identical existing object is skipped without overwrite', async () => {
  const client = createClient(() => ({
    ContentLength: 123,
    Metadata: { sha256 },
    ETag: '"existing"',
  }));
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example' });

  let bodyFactoryCalls = 0;
  const result = await store.put({
    key,
    bodyFactory() {
      bodyFactoryCalls += 1;
      return Buffer.from('not consumed');
    },
    contentType: 'image/jpeg',
    sizeBytes: 123,
    sha256,
  });

  assert.equal(bodyFactoryCalls, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(commandName(client.calls[0]), 'HeadObjectCommand');
  assert.deepEqual(result, {
    key,
    sizeBytes: 123,
    sha256,
    etag: '"existing"',
    skipped: true,
  });
});

test('R2MediaStore: conflicting existing key rejects and never issues PutObject', async () => {
  const client = createClient(() => ({
    ContentLength: 124,
    Metadata: { sha256: `0${sha256.slice(1)}` },
    ETag: '"conflict"',
  }));
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example' });

  await assert.rejects(
    store.put({
      key,
      body: Buffer.from('new'),
      contentType: 'image/jpeg',
      sizeBytes: 123,
      sha256,
    }),
    /conflict|already exists|不覆盖/i,
  );
  assert.deepEqual(client.calls.map(commandName), ['HeadObjectCommand']);
});

test('R2MediaStore: a conditional-put race accepts only an identical winner', async () => {
  let headCalls = 0;
  const client = createClient((command) => {
    if (commandName(command) === 'HeadObjectCommand') {
      headCalls += 1;
      if (headCalls === 1) {
        const error = new Error('missing');
        error.name = 'NotFound';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        ContentLength: 123,
        Metadata: { sha256 },
        ETag: '"race-winner"',
      };
    }
    if (commandName(command) === 'PutObjectCommand') {
      assert.equal(command.input.IfNoneMatch, '*');
      const error = new Error('precondition failed');
      error.name = 'PreconditionFailed';
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    throw new Error(`Unexpected command: ${commandName(command)}`);
  });
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example' });

  const result = await store.put({
    key,
    bodyFactory: () => Buffer.from('candidate'),
    contentType: 'image/jpeg',
    sizeBytes: 123,
    sha256,
  });

  assert.deepEqual(client.calls.map(commandName), ['HeadObjectCommand', 'PutObjectCommand', 'HeadObjectCommand']);
  assert.deepEqual(result, {
    key,
    sizeBytes: 123,
    sha256,
    etag: '"race-winner"',
    skipped: true,
  });
});

test('R2MediaStore: delete is idempotent and publicUrl encodes path segments', async () => {
  const client = createClient((command) => {
    assert.equal(commandName(command), 'DeleteObjectCommand');
    return {};
  });
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example/' });

  await store.delete(key);

  assert.deepEqual(client.calls[0].input, { Bucket: 'bucket', Key: key });
  assert.equal(store.publicUrl('articles/88/images/512/hash small.jpg'), 'https://media.example/articles/88/images/512/hash%20small.jpg');
});

test('R2MediaStore: list uses ListObjectsV2 pagination inputs and normalizes object summaries', async () => {
  const client = createClient((command) => {
    assert.equal(commandName(command), 'ListObjectsV2Command');
    return {
      Contents: [{ Key: key, Size: 123, ETag: '"listed"', LastModified: new Date('2026-08-01T00:00:00Z') }],
      IsTruncated: true,
      NextContinuationToken: 'next-page',
    };
  });
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example' });

  const result = await store.list({ continuationToken: 'current-page', prefix: 'articles/', maxKeys: 25 });

  assert.deepEqual(client.calls[0].input, {
    Bucket: 'bucket',
    ContinuationToken: 'current-page',
    Prefix: 'articles/',
    MaxKeys: 25,
  });
  assert.deepEqual(result, {
    objects: [{ key, sizeBytes: 123, etag: '"listed"', lastModified: new Date('2026-08-01T00:00:00Z') }],
    continuationToken: 'next-page',
  });
});

test('R2MediaStore: put, head and delete all reject unsafe object keys', async () => {
  const client = createClient(() => {
    throw new Error('S3 client must not receive unsafe keys');
  });
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example' });

  await assert.rejects(
    store.put({
      key: '../escaped.jpg',
      body: Buffer.from('unsafe'),
      contentType: 'image/jpeg',
      sizeBytes: 6,
      sha256,
    }),
    /unsafe|relative|key/i,
  );
  await assert.rejects(store.head('../escaped.jpg'), /unsafe|relative|key/i);
  await assert.rejects(store.delete('../escaped.jpg'), /unsafe|relative|key/i);
  assert.equal(client.calls.length, 0);
});

test('R2MediaStore: a generic PUT failure destroys the opened snapshot stream', async () => {
  let uploadStream;
  const client = createClient((command) => {
    if (commandName(command) === 'HeadObjectCommand') {
      const error = new Error('missing');
      error.name = 'NotFound';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    throw new Error('R2 unavailable');
  });
  const store = createR2MediaStore({ client, bucket: 'bucket', publicBaseUrl: 'https://media.example' });

  await assert.rejects(
    store.put({
      key,
      bodyFactory() {
        uploadStream = Readable.from(Buffer.from('snapshot'));
        return uploadStream;
      },
      contentType: 'image/jpeg',
      sizeBytes: 8,
      sha256,
    }),
    /unavailable/i,
  );

  assert.equal(uploadStream.destroyed, true);
});
