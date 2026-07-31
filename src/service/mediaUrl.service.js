const { MEDIA_OBJECT_STATUS, MEDIA_READ_MODE, MEDIA_VARIANT } = require('@/constants/mediaStorage');

function normalizeFileId(fileId) {
  const normalized = Number(fileId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('fileId must be a positive safe integer');
  }
  return normalized;
}

class MediaUrlService {
  constructor({ mediaObjectService, r2Store, localUrlResolver, readMode = MEDIA_READ_MODE.LOCAL }) {
    if (!mediaObjectService || typeof mediaObjectService.findReadyR2Objects !== 'function') {
      throw new TypeError('an injected mediaObjectService is required');
    }
    if (!r2Store || typeof r2Store.publicUrl !== 'function') {
      throw new TypeError('an injected r2Store is required');
    }
    if (typeof localUrlResolver !== 'function') {
      throw new TypeError('an injected localUrlResolver is required');
    }
    if (!Object.values(MEDIA_READ_MODE).includes(readMode)) {
      throw new TypeError(`unsupported media read mode: ${readMode}`);
    }

    this.mediaObjectService = mediaObjectService;
    this.r2Store = r2Store;
    this.localUrlResolver = localUrlResolver;
    this.readMode = readMode;
  }

  async resolveVariant(fileId, variant, fallbackVariant = null) {
    const normalizedFileId = normalizeFileId(fileId);
    if (this.readMode === MEDIA_READ_MODE.R2_PREFERRED) {
      const objects = await this.mediaObjectService.findReadyR2Objects(normalizedFileId);
      const readyObjects = objects.filter((object) => object?.status === MEDIA_OBJECT_STATUS.READY && typeof object.objectKey === 'string');
      const preferred = readyObjects.find((object) => object.variant === variant) || (fallbackVariant ? readyObjects.find((object) => object.variant === fallbackVariant) : null);

      if (preferred) {
        return this.r2Store.publicUrl(preferred.objectKey);
      }
    }

    return this.localUrlResolver(normalizedFileId, variant);
  }

  async resolveImageUrl(fileId, { variant = MEDIA_VARIANT.ORIGINAL } = {}) {
    if (![MEDIA_VARIANT.ORIGINAL, MEDIA_VARIANT.SMALL].includes(variant)) {
      throw new TypeError('image variant must be original or small');
    }
    return this.resolveVariant(fileId, variant, variant === MEDIA_VARIANT.SMALL ? MEDIA_VARIANT.ORIGINAL : null);
  }

  async resolveVideoUrl(fileId) {
    return this.resolveVariant(fileId, MEDIA_VARIANT.VIDEO);
  }

  async resolveVideoPosterUrl(fileId) {
    return this.resolveVariant(fileId, MEDIA_VARIANT.POSTER);
  }
}

function createMediaUrlService(options) {
  return new MediaUrlService(options);
}

module.exports = {
  MediaUrlService,
  createMediaUrlService,
};
