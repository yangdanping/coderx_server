const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('module-alias/register');

let createLocalImageUrlResolver;
try {
  ({ createLocalImageUrlResolver } = require('@/service/localImageUrlResolver.service'));
} catch {
  createLocalImageUrlResolver = undefined;
}

async function createFixture(t, { withSmall }) {
  const imageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-local-image-url-'));
  await fs.writeFile(path.join(imageRoot, 'cover.jpg'), 'original');
  if (withSmall) await fs.writeFile(path.join(imageRoot, 'cover-small.jpg'), 'small');
  t.after(() => fs.rm(imageRoot, { recursive: true, force: true }));
  return imageRoot;
}

function createDatabase(filename = 'cover.jpg') {
  return {
    async execute(statement, params) {
      assert.match(statement, /FROM file/i);
      assert.deepEqual(params, [41]);
      return [[{ id: 41, filename, file_type: 'image' }], []];
    },
  };
}

test('local image URL resolver: original returns the current API image route', async (t) => {
  assert.equal(typeof createLocalImageUrlResolver, 'function');
  const imageRoot = await createFixture(t, { withSmall: true });
  const resolveLocalImageUrl = createLocalImageUrlResolver({
    database: createDatabase(),
    imageRoot,
    publicApiOrigin: 'https://api.example/',
  });

  assert.equal(await resolveLocalImageUrl(41, 'original'), 'https://api.example/article/images/cover.jpg');
});

test('local image URL resolver: small uses the thumbnail route only when the physical variant exists', async (t) => {
  assert.equal(typeof createLocalImageUrlResolver, 'function');
  const withSmallRoot = await createFixture(t, { withSmall: true });
  const withoutSmallRoot = await createFixture(t, { withSmall: false });
  const withSmall = createLocalImageUrlResolver({
    database: createDatabase(),
    imageRoot: withSmallRoot,
    publicApiOrigin: 'https://api.example',
  });
  const withoutSmall = createLocalImageUrlResolver({
    database: createDatabase(),
    imageRoot: withoutSmallRoot,
    publicApiOrigin: 'https://api.example',
  });

  assert.equal(await withSmall(41, 'small'), 'https://api.example/article/images/cover.jpg?type=small');
  assert.equal(await withoutSmall(41, 'small'), 'https://api.example/article/images/cover.jpg');
});

test('local image URL resolver: unsafe database filenames are rejected before filesystem access', async (t) => {
  assert.equal(typeof createLocalImageUrlResolver, 'function');
  const imageRoot = await createFixture(t, { withSmall: false });
  const resolveLocalImageUrl = createLocalImageUrlResolver({
    database: createDatabase('../secret.jpg'),
    imageRoot,
    publicApiOrigin: 'https://api.example',
  });

  await assert.rejects(resolveLocalImageUrl(41, 'original'), /filename|path|unsafe/i);
});
