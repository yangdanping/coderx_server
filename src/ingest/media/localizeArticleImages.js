const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Jimp } = require('jimp');
const { safeRemoteFetch } = require('@/ingest/extraction/safeRemoteFetch');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 6;
const MAX_IMAGES = 3;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 270;

function imageHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
}

function smallFilename(filename) {
  const extension = path.extname(filename);
  return filename.slice(0, -extension.length) + '-small' + extension;
}

async function defaultFetchImage(url) {
  return await safeRemoteFetch(url, {
    maxBytes: MAX_IMAGE_BYTES,
    allowedContentTypes: ['image/'],
  });
}

async function localizeArticleImages({ candidateId, images, outputDir, fetchImage = defaultFetchImage, maxImages = MAX_IMAGES }) {
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new Error('candidateId must be a positive integer');
  if (!Array.isArray(images) || images.length === 0) throw new Error('image candidates are required');
  if (!outputDir) throw new Error('outputDir is required');
  await fs.mkdir(outputDir, { recursive: true });

  const deduplicated = [];
  const seen = new Set();
  for (const image of images) {
    const url = String(image?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduplicated.push({ ...image, url });
    if (deduplicated.length === MAX_CANDIDATES) break;
  }

  const assets = [];
  const createdPaths = [];
  const cleanup = async () => {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true })));
  };

  try {
    for (const candidate of deduplicated) {
      if (assets.length >= Math.min(maxImages, MAX_IMAGES)) break;
      let fetched;
      try {
        fetched = await fetchImage(candidate.url);
      } catch {
        continue;
      }
      if (!Buffer.isBuffer(fetched?.buffer)) continue;

      let image;
      try {
        image = await Jimp.read(fetched.buffer);
      } catch {
        continue;
      }
      const originalWidth = image.bitmap.width;
      const originalHeight = image.bitmap.height;
      if (originalWidth < MIN_WIDTH || originalHeight < MIN_HEIGHT) continue;
      if (image.bitmap.width > 1600) image.resize({ w: 1600 });

      const index = assets.length + 1;
      const filename = `ingest-${candidateId}-${index}-${imageHash(candidate.url)}.jpg`;
      const thumbnailFilename = smallFilename(filename);
      const temporaryPath = path.resolve(outputDir, filename);
      const smallTemporaryPath = path.resolve(outputDir, thumbnailFilename);
      const fullBuffer = await image.getBuffer('image/jpeg', { quality: 82 });
      const thumbnail = image.clone().resize({ w: 320 });
      const thumbnailBuffer = await thumbnail.getBuffer('image/jpeg', { quality: 80 });

      await fs.writeFile(temporaryPath, fullBuffer);
      createdPaths.push(temporaryPath);
      await fs.writeFile(smallTemporaryPath, thumbnailBuffer);
      createdPaths.push(smallTemporaryPath);
      assets.push({
        filename,
        smallFilename: thumbnailFilename,
        mimetype: 'image/jpeg',
        size: fullBuffer.byteLength,
        width: image.bitmap.width,
        height: image.bitmap.height,
        alt: String(candidate.alt || '')
          .trim()
          .slice(0, 180),
        caption: String(candidate.caption || '')
          .trim()
          .slice(0, 240),
        isCover: candidate.isCover === true,
        temporaryPath,
        smallTemporaryPath,
        sourceUrl: candidate.url,
      });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  if (assets.length === 0) {
    await cleanup();
    throw new Error('No usable article image passed validation');
  }
  const coverIndex = assets.findIndex((asset) => asset.isCover);
  if (coverIndex > 0) assets.unshift(assets.splice(coverIndex, 1)[0]);
  assets.forEach((asset, index) => {
    asset.isCover = index === 0;
  });

  return { assets, cleanup };
}

module.exports = {
  localizeArticleImages,
  smallFilename,
};
