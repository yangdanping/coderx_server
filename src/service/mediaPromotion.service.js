const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { IMMUTABLE_CACHE_CONTROL, MEDIA_OBJECT_STATUS } = require('@/constants/mediaStorage');
const { buildMediaObjectKey } = require('@/utils/mediaObjectKey');

async function inspectLocalFile(localPath) {
  const stats = await fsPromises.stat(localPath);
  if (!stats.isFile()) {
    throw new TypeError(`Local media path is not a file: ${localPath}`);
  }

  const hash = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(localPath)) {
    hash.update(chunk);
    md5.update(chunk);
    sizeBytes += chunk.length;
  }

  if (sizeBytes !== stats.size) {
    throw new Error(`Local media changed while hashing: ${localPath}`);
  }

  return {
    sizeBytes,
    sha256: hash.digest('hex'),
    contentMd5: md5.digest('base64'),
  };
}

async function createLocalSnapshot(localPath) {
  const sourceStats = await fsPromises.stat(localPath);
  if (!sourceStats.isFile()) {
    throw new TypeError(`Local media path is not a file: ${localPath}`);
  }

  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'coderx-media-promotion-'));
  const snapshotPath = path.join(temporaryDirectory, 'snapshot');
  try {
    await fsPromises.copyFile(localPath, snapshotPath);
    const inspected = await inspectLocalFile(snapshotPath);
    return {
      ...inspected,
      snapshotPath,
      async cleanup() {
        await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function verifiedHead(head, expected) {
  return !!head && head.sizeBytes === expected.sizeBytes && head.sha256 === expected.sha256;
}

class MediaPromotionService {
  constructor({ mediaObjectService, r2Store, snapshotFactory = createLocalSnapshot }) {
    if (!mediaObjectService || typeof mediaObjectService.reserveR2Object !== 'function') {
      throw new TypeError('an injected mediaObjectService is required');
    }
    if (!r2Store || typeof r2Store.put !== 'function' || typeof r2Store.head !== 'function') {
      throw new TypeError('an injected r2Store is required');
    }
    if (typeof snapshotFactory !== 'function') {
      throw new TypeError('snapshotFactory must be a function');
    }
    this.mediaObjectService = mediaObjectService;
    this.r2Store = r2Store;
    this.snapshotFactory = snapshotFactory;
  }

  async promote({ articleId, fileId, variant, localPath, contentType, extension, filename }) {
    const snapshot = await this.snapshotFactory(localPath);
    let key;
    let mediaObject;
    let ownsReservation = false;
    try {
      key = buildMediaObjectKey({
        articleId,
        fileId,
        sha256: snapshot.sha256,
        variant,
        extension: extension ?? path.extname(filename || localPath),
      });

      const reservation = await this.mediaObjectService.reserveR2Object({
        fileId,
        variant,
        objectKey: key,
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256,
      });
      mediaObject = reservation.mediaObject;
      ownsReservation = reservation.reserved === true;

      if (!ownsReservation && mediaObject.status === MEDIA_OBJECT_STATUS.PENDING) {
        return {
          key,
          sizeBytes: snapshot.sizeBytes,
          sha256: snapshot.sha256,
          etag: null,
          skipped: true,
          inProgress: true,
          retainedLocal: true,
        };
      }

      if (!ownsReservation && mediaObject.status === MEDIA_OBJECT_STATUS.READY) {
        const existing = await this.r2Store.head(key);
        if (verifiedHead(existing, snapshot)) {
          return {
            ...existing,
            skipped: true,
            retainedLocal: true,
          };
        }
        const verificationError = new Error(`R2 ready-object verification conflict for "${key}"`);
        await this.mediaObjectService.markVerificationFailed(mediaObject, verificationError);
        throw verificationError;
      }

      if (!ownsReservation) {
        throw new Error(`Media promotion for "${key}" has no upload reservation`);
      }

      const stored = await this.r2Store.put({
        key,
        bodyFactory: () => fs.createReadStream(snapshot.snapshotPath),
        contentType,
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256,
        contentMd5: snapshot.contentMd5,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
      const head = await this.r2Store.head(key);
      if (!verifiedHead(head, snapshot)) {
        throw new Error(`R2 HEAD verification failed for "${key}": expected ${snapshot.sizeBytes}/${snapshot.sha256}`);
      }

      await this.mediaObjectService.markReady(mediaObject);
      return {
        ...head,
        skipped: stored.skipped === true,
        retainedLocal: true,
      };
    } catch (error) {
      if (ownsReservation && mediaObject?.id != null) {
        try {
          await this.mediaObjectService.markFailed(mediaObject, error);
        } catch {
          // Preserve the promotion error; reconciliation can repair a stale pending row.
        }
      }
      throw error;
    } finally {
      await snapshot.cleanup();
    }
  }
}

function createMediaPromotionService(options) {
  return new MediaPromotionService(options);
}

module.exports = {
  MediaPromotionService,
  createMediaPromotionService,
  createLocalSnapshot,
  inspectLocalFile,
};
