import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IMMUTABLE_CACHE_CONTROL, MEDIA_OBJECT_STATUS, type MediaVariant } from '../constants/mediaStorage.js';
import type { R2MediaMetadata, R2MediaPutInput, R2MediaStore } from '../storage/r2MediaStore.js';
import { buildMediaObjectKey } from '../utils/mediaObjectKey.js';
import type { MediaObjectRow, MediaReservation } from './mediaObject.service.js';

interface LocalMediaInspection {
  sizeBytes: number;
  sha256: string;
  contentMd5: string;
}

interface LocalMediaSnapshot extends LocalMediaInspection {
  snapshotPath: string;
  cleanup(): Promise<void>;
}

export interface MediaPromotionInput {
  articleId?: number | string | null;
  fileId: number | string;
  variant: MediaVariant;
  localPath: string;
  contentType?: string;
  extension?: string | null;
  filename?: string | null;
}

interface MediaPromotionResult extends R2MediaMetadata {
  sha256: string;
  skipped: boolean;
  inProgress?: true;
  retainedLocal: true;
}

type PromotionMediaObject = Pick<MediaObjectRow, 'id' | 'objectKey' | 'sizeBytes' | 'sha256' | 'status'>;
interface MediaPromotionOptions {
  mediaObjectService: {
    reserveR2Object(payload: MediaReservation): Promise<{ reserved: boolean; mediaObject: PromotionMediaObject }>;
    markReady(mediaObject: PromotionMediaObject): Promise<unknown>;
    markFailed(mediaObject: PromotionMediaObject, error: unknown): Promise<unknown>;
    markVerificationFailed(mediaObject: PromotionMediaObject, error: unknown): Promise<unknown>;
  };
  r2Store: Pick<R2MediaStore, 'head'> & { put(payload: R2MediaPutInput): Promise<{ skipped?: boolean }> };
  snapshotFactory?(localPath: string): Promise<LocalMediaSnapshot>;
}

export async function inspectLocalFile(localPath: string): Promise<LocalMediaInspection> {
  const stats = await fsPromises.stat(localPath);
  if (!stats.isFile()) {
    throw new TypeError(`Local media path is not a file: ${localPath}`);
  }

  const hash = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  let sizeBytes = 0;
  const stream: AsyncIterable<Buffer> = fs.createReadStream(localPath);
  for await (const chunk of stream) {
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

export async function createLocalSnapshot(localPath: string): Promise<LocalMediaSnapshot> {
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

function verifiedHead(head: R2MediaMetadata | null, expected: LocalMediaInspection): head is R2MediaMetadata & { sha256: string } {
  return !!head && head.sizeBytes === expected.sizeBytes && head.sha256 === expected.sha256;
}

export class MediaPromotionService {
  declare mediaObjectService: MediaPromotionOptions['mediaObjectService'];
  declare r2Store: MediaPromotionOptions['r2Store'];
  declare snapshotFactory: NonNullable<MediaPromotionOptions['snapshotFactory']>;

  constructor({ mediaObjectService, r2Store, snapshotFactory = createLocalSnapshot }: MediaPromotionOptions) {
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

  async promote({ articleId, fileId, variant, localPath, contentType, extension, filename }: MediaPromotionInput): Promise<MediaPromotionResult> {
    const snapshot = await this.snapshotFactory(localPath);
    let mediaObject: PromotionMediaObject | undefined;
    let ownsReservation = false;
    try {
      const mediaObjectKeyInput: Parameters<typeof buildMediaObjectKey>[0] = {
        fileId,
        sha256: snapshot.sha256,
        variant,
        extension: extension ?? path.extname(filename || localPath),
      };
      if (articleId != null) {
        mediaObjectKeyInput.articleId = articleId;
      }
      const key = buildMediaObjectKey(mediaObjectKeyInput);

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

export function createMediaPromotionService(options: MediaPromotionOptions): MediaPromotionService {
  return new MediaPromotionService(options);
}
