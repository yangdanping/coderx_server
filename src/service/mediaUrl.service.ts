import { MEDIA_OBJECT_STATUS, MEDIA_READ_MODE, MEDIA_VARIANT, type MediaReadMode, type MediaVariant } from '../constants/mediaStorage.js';
import type { R2MediaStore } from '../storage/r2MediaStore.js';

interface UrlMediaObject {
  objectKey: string | null;
  status: string;
  variant: MediaVariant;
}

interface MediaUrlOptions {
  mediaObjectService: { findReadyR2Objects(fileId: number): Promise<readonly (UrlMediaObject | null)[]> };
  r2Store: Pick<R2MediaStore, 'publicUrl'>;
  localUrlResolver(fileId: number, variant: MediaVariant): string | null | Promise<string | null>;
  readMode?: string;
}

type ImageVariant = Extract<MediaVariant, 'original' | 'small'>;
const readModes = new Set<string>(Object.values(MEDIA_READ_MODE));

function isMediaReadMode(value: string): value is MediaReadMode {
  return readModes.has(value);
}

function normalizeFileId(fileId: unknown): number {
  const normalized = Number(fileId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('fileId must be a positive safe integer');
  }
  return normalized;
}

export class MediaUrlService {
  declare mediaObjectService: MediaUrlOptions['mediaObjectService'];
  declare r2Store: MediaUrlOptions['r2Store'];
  declare localUrlResolver: MediaUrlOptions['localUrlResolver'];
  declare readMode: MediaReadMode;

  constructor({ mediaObjectService, r2Store, localUrlResolver, readMode = MEDIA_READ_MODE.LOCAL }: MediaUrlOptions) {
    if (!mediaObjectService || typeof mediaObjectService.findReadyR2Objects !== 'function') {
      throw new TypeError('an injected mediaObjectService is required');
    }
    if (!r2Store || typeof r2Store.publicUrl !== 'function') {
      throw new TypeError('an injected r2Store is required');
    }
    if (typeof localUrlResolver !== 'function') {
      throw new TypeError('an injected localUrlResolver is required');
    }
    if (!isMediaReadMode(readMode)) {
      throw new TypeError(`unsupported media read mode: ${readMode}`);
    }

    this.mediaObjectService = mediaObjectService;
    this.r2Store = r2Store;
    this.localUrlResolver = localUrlResolver;
    this.readMode = readMode;
  }

  async resolveVariant(fileId: number | string, variant: MediaVariant, fallbackVariant: MediaVariant | null = null): Promise<string | null> {
    const normalizedFileId = normalizeFileId(fileId);
    if (this.readMode === MEDIA_READ_MODE.R2_PREFERRED) {
      const objects = await this.mediaObjectService.findReadyR2Objects(normalizedFileId);
      const readyObjects = objects.filter(
        (object): object is UrlMediaObject & { objectKey: string } => object?.status === MEDIA_OBJECT_STATUS.READY && typeof object.objectKey === 'string',
      );
      const preferred = readyObjects.find((object) => object.variant === variant) || (fallbackVariant ? readyObjects.find((object) => object.variant === fallbackVariant) : null);

      if (preferred) {
        return this.r2Store.publicUrl(preferred.objectKey);
      }
    }

    return this.localUrlResolver(normalizedFileId, variant);
  }

  async resolveImageUrl(fileId: number | string, { variant = MEDIA_VARIANT.ORIGINAL }: { variant?: ImageVariant } = {}) {
    if (![MEDIA_VARIANT.ORIGINAL, MEDIA_VARIANT.SMALL].includes(variant)) {
      throw new TypeError('image variant must be original or small');
    }
    return this.resolveVariant(fileId, variant, variant === MEDIA_VARIANT.SMALL ? MEDIA_VARIANT.ORIGINAL : null);
  }

  async resolveVideoUrl(fileId: number | string) {
    return this.resolveVariant(fileId, MEDIA_VARIANT.VIDEO);
  }

  async resolveVideoPosterUrl(fileId: number | string) {
    return this.resolveVariant(fileId, MEDIA_VARIANT.POSTER);
  }
}

export function createMediaUrlService(options: MediaUrlOptions): MediaUrlService {
  return new MediaUrlService(options);
}
