const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Jimp } = require('jimp');

require('module-alias/register');

const { localizeArticleImages } = require('@/ingest/media/localizeArticleImages');

async function imageBuffer(width, height, color) {
  const image = new Jimp({ width, height, color });
  return await image.getBuffer('image/png');
}

test('localizeArticleImages filters small images, deduplicates URLs and creates local thumbnails', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-rich-media-'));
  const buffers = new Map([
    ['https://img.example/cover.png', await imageBuffer(1200, 675, 0x336699ff)],
    ['https://img.example/small.png', await imageBuffer(320, 180, 0xff0000ff)],
    ['https://img.example/body-a.png', await imageBuffer(900, 600, 0x00ff00ff)],
    ['https://img.example/body-b.png', await imageBuffer(1000, 700, 0x0000ffff)],
  ]);
  const requested = [];

  const result = await localizeArticleImages({
    candidateId: 70,
    outputDir,
    images: [
      { url: 'https://img.example/cover.png', alt: '文章封面', isCover: true },
      { url: 'https://img.example/cover.png', alt: '重复封面' },
      { url: 'https://img.example/small.png', alt: '尺寸过小' },
      { url: 'https://img.example/broken.png', alt: '下载失败' },
      { url: 'https://img.example/body-a.png', alt: '正文图片 A' },
      { url: 'https://img.example/body-b.png', alt: '正文图片 B' },
    ],
    fetchImage: async (url) => {
      requested.push(url);
      if (url.endsWith('/broken.png')) throw new Error('upstream unavailable');
      return {
        buffer: buffers.get(url),
        contentType: 'image/png',
      };
    },
  });

  assert.equal(result.assets.length, 3);
  assert.equal(result.assets[0].isCover, true);
  assert.equal(new Set(result.assets.map((asset) => asset.filename)).size, 3);
  assert.ok(result.assets.every((asset) => asset.filename.startsWith('ingest-70-')));
  assert.ok(result.assets.every((asset) => asset.mimetype === 'image/jpeg'));
  assert.ok(result.assets.every((asset) => asset.width >= 480 && asset.height >= 270));
  assert.equal(requested.filter((url) => url.endsWith('/cover.png')).length, 1);

  for (const asset of result.assets) {
    await fs.access(asset.temporaryPath);
    await fs.access(asset.smallTemporaryPath);
  }
  await result.cleanup();
  for (const asset of result.assets) {
    await assert.rejects(() => fs.access(asset.temporaryPath), /ENOENT/);
    await assert.rejects(() => fs.access(asset.smallTemporaryPath), /ENOENT/);
  }
});

test('localizeArticleImages rejects a batch without a usable cover', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-rich-media-empty-'));
  const small = await imageBuffer(200, 100, 0xffffffff);

  await assert.rejects(
    () =>
      localizeArticleImages({
        candidateId: 21,
        outputDir,
        images: [{ url: 'https://img.example/small.png', isCover: true }],
        fetchImage: async () => ({ buffer: small, contentType: 'image/png' }),
      }),
    /usable article image/i,
  );
  await fs.rm(outputDir, { recursive: true, force: true });
});
