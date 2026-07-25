const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { safeRemoteFetch } = require('@/ingest/extraction/safeRemoteFetch');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 6;
const MAX_IMAGES = 3;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 270;

function imageHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10);
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

      let sourceImage;
      let metadata;
      try {
        sourceImage = sharp(fetched.buffer, { failOn: 'warning' }).rotate();
        metadata = await sourceImage.metadata();
      } catch {
        continue;
      }
      const originalWidth = Number(metadata.width);
      const originalHeight = Number(metadata.height);
      if (originalWidth < MIN_WIDTH || originalHeight < MIN_HEIGHT) continue;

      let fullBuffer;
      let fullInfo;
      let thumbnailBuffer;
      try {
        const rendered = await sourceImage
          .clone()
          .resize({ width: 1600, withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer({ resolveWithObject: true });
        fullBuffer = rendered.data;
        fullInfo = rendered.info;
        thumbnailBuffer = await sharp(fullBuffer).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      } catch {
        continue;
      }
      const index = assets.length + 1;
      const filename = `ingest-${candidateId}-${index}-${imageHash(fullBuffer)}.jpg`;
      const thumbnailFilename = smallFilename(filename);
      const temporaryPath = path.resolve(outputDir, filename);
      const smallTemporaryPath = path.resolve(outputDir, thumbnailFilename);

      await fs.writeFile(temporaryPath, fullBuffer);
      createdPaths.push(temporaryPath);
      await fs.writeFile(smallTemporaryPath, thumbnailBuffer);
      createdPaths.push(smallTemporaryPath);
      assets.push({
        filename,
        smallFilename: thumbnailFilename,
        mimetype: 'image/jpeg',
        size: fullBuffer.byteLength,
        width: fullInfo.width,
        height: fullInfo.height,
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
