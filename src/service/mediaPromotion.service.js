const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { IMMUTABLE_CACHE_CONTROL, MEDIA_OBJECT_STATUS } = require('@/constants/mediaStorage');
const { buildMediaObjectKey } = require('@/utils/mediaObjectKey');

async function inspectLocalFile(localPath) {
  const stats = await fsPromises.stat(localPath);
  if (!stats.isFile()) {
    throw new TypeError(`Local media path is not a file: ${localPath}`);
  }

  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(localPath)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }

  if (sizeBytes !== stats.size) {
    throw new Error(`Local media changed while hashing: ${localPath}`);
  }

  return {
    sizeBytes,
    sha256: hash.digest('hex'),
  };
}

function verifiedHead(head, expected) {
  return !!head && head.sizeBytes === expected.sizeBytes && head.sha256 === expected.sha256;
}

class MediaPromotionService {
  constructor({ mediaObjectService, r2Store }) {
    if (!mediaObjectService || typeof mediaObjectService.reserveR2Object !== 'function') {
      throw new TypeError('an injected mediaObjectService is required');
    }
    if (!r2Store || typeof r2Store.put !== 'function' || typeof r2Store.head !== 'function') {
      throw new TypeError('an injected r2Store is required');
    }
    this.mediaObjectService = mediaObjectService;
    this.r2Store = r2Store;
  }

  async promote({ articleId, fileId, variant, localPath, contentType, extension, filename }) {
    const inspected = await inspectLocalFile(localPath);
    const key = buildMediaObjectKey({
      articleId,
      fileId,
      sha256: inspected.sha256,
      variant,
      extension: extension ?? path.extname(filename || localPath),
    });

    let mediaObject;
    try {
      const reservation = await this.mediaObjectService.reserveR2Object({
        fileId,
        variant,
        objectKey: key,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
      });
      mediaObject = reservation.mediaObject;

      if (!reservation.reserved && mediaObject.status === MEDIA_OBJECT_STATUS.READY) {
        const existing = await this.r2Store.head(key);
        if (verifiedHead(existing, inspected)) {
          return {
            ...existing,
            skipped: true,
            retainedLocal: true,
          };
        }
      }

      const stored = await this.r2Store.put({
        key,
        body: fs.createReadStream(localPath),
        contentType,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
      const head = await this.r2Store.head(key);
      if (!verifiedHead(head, inspected)) {
        throw new Error(`R2 HEAD verification failed for "${key}": expected ${inspected.sizeBytes}/${inspected.sha256}`);
      }

      await this.mediaObjectService.markReady(mediaObject.id);
      return {
        ...head,
        skipped: stored.skipped === true,
        retainedLocal: true,
      };
    } catch (error) {
      if (mediaObject?.id != null) {
        try {
          await this.mediaObjectService.markFailed(mediaObject.id, error);
        } catch {
          // Preserve the promotion error; reconciliation can repair a stale pending row.
        }
      }
      throw error;
    }
  }
}

function createMediaPromotionService(options) {
  return new MediaPromotionService(options);
}

module.exports = {
  MediaPromotionService,
  createMediaPromotionService,
  inspectLocalFile,
};
