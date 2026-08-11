const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('module-alias/register');

const { buildMediaObjectKey } = require('@/utils/mediaObjectKey');

const SHA256 = crypto.createHash('sha256').update('immutable key fixture').digest('hex');

test('buildMediaObjectKey: builds exact immutable image keys from article, file, hash, variant and extension', () => {
  assert.equal(
    buildMediaObjectKey({
      articleId: 88,
      fileId: 512,
      sha256: SHA256,
      variant: 'original',
      extension: '.JPG',
    }),
    `articles/88/images/512/${SHA256.slice(0, 12)}-original.jpg`,
  );

  assert.equal(
    buildMediaObjectKey({
      articleId: '88',
      fileId: '512',
      sha256: SHA256,
      variant: 'small',
      filename: 'cover.png',
    }),
    `articles/88/images/512/${SHA256.slice(0, 12)}-small.png`,
  );
});

test('buildMediaObjectKey: builds exact immutable video and poster keys', () => {
  assert.equal(
    buildMediaObjectKey({
      articleId: 88,
      fileId: 640,
      sha256: SHA256,
      variant: 'video',
      extension: 'mp4',
    }),
    `articles/88/videos/640/${SHA256.slice(0, 12)}-video.mp4`,
  );

  assert.equal(
    buildMediaObjectKey({
      articleId: 88,
      fileId: 640,
      sha256: SHA256,
      variant: 'poster',
      filename: 'clip-poster.jpeg',
    }),
    `articles/88/videos/640/${SHA256.slice(0, 12)}-poster.jpeg`,
  );
});

test('buildMediaObjectKey creates neutral keys when articleId is omitted', () => {
  assert.equal(
    buildMediaObjectKey({
      fileId: 512,
      sha256: SHA256,
      variant: 'small',
      extension: 'webp',
    }),
    `media/images/512/${SHA256.slice(0, 12)}-small.webp`,
  );
});

test('buildMediaObjectKey: rejects traversal and malformed path components', () => {
  const base = {
    articleId: 88,
    fileId: 512,
    sha256: SHA256,
    variant: 'original',
  };

  for (const unsafeExtension of ['../jpg', '..', '/tmp/jpg', 'jpg/evil', 'jpg\\evil', '.']) {
    assert.throws(() => buildMediaObjectKey({ ...base, extension: unsafeExtension }), /extension|path|安全|invalid/i);
  }

  assert.throws(() => buildMediaObjectKey({ ...base, articleId: '../88', extension: 'jpg' }), /article/i);
  assert.throws(() => buildMediaObjectKey({ ...base, fileId: '512/evil', extension: 'jpg' }), /file/i);
  assert.throws(() => buildMediaObjectKey({ ...base, filename: '../cover.jpg' }), /filename|path|安全|invalid/i);
});
