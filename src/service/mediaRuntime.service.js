const path = require('node:path');
const config = require('@/app/config');
const database = require('@/app/database');
const { IMG_PATH } = require('@/constants/filePaths');
const { baseURL } = require('@/constants/urls');
const { createLocalImageUrlResolver } = require('@/service/localImageUrlResolver.service');
const { createMediaDeletionService } = require('@/service/mediaDeletion.service');
const { createMediaObjectService } = require('@/service/mediaObject.service');
const { createMediaPromotionService } = require('@/service/mediaPromotion.service');
const { createMediaUrlService } = require('@/service/mediaUrl.service');
const { createPublishedImagePromotionService } = require('@/service/publishedImagePromotion.service');
const { createR2Client, createR2MediaStore } = require('@/storage/r2MediaStore');

let r2PromotionService;
let r2Store;
let mediaObjectService;
let mediaUrlService;
let mediaDeletionService;

function getMediaObjectService() {
  if (!mediaObjectService) {
    mediaObjectService = createMediaObjectService({
      database,
      hardLimitBytes: Number(config.R2_HARD_LIMIT_BYTES),
    });
  }
  return mediaObjectService;
}

function getR2PromotionService() {
  if (!r2PromotionService) {
    r2PromotionService = createMediaPromotionService({
      mediaObjectService: getMediaObjectService(),
      r2Store: getR2Store(),
    });
  }
  return r2PromotionService;
}

function getR2Store() {
  if (!r2Store) {
    r2Store = createR2MediaStore({
      client: createR2Client({
        accountId: config.R2_ACCOUNT_ID,
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      }),
      bucket: config.R2_BUCKET,
      publicBaseUrl: config.MEDIA_CDN_BASE_URL,
    });
  }
  return r2Store;
}

function getMediaDeletionService() {
  if (!mediaDeletionService) {
    mediaDeletionService = createMediaDeletionService({
      mediaObjectService: getMediaObjectService(),
      r2Store: {
        delete(key) {
          return getR2Store().delete(key);
        },
      },
    });
  }
  return mediaDeletionService;
}

function getMediaUrlService() {
  if (!mediaUrlService) {
    const r2PublicUrlStore = createR2MediaStore({
      client: {
        async send() {
          throw new Error('The CDN URL resolver must not call the R2 S3 API');
        },
      },
      bucket: config.R2_BUCKET,
      publicBaseUrl: config.MEDIA_CDN_BASE_URL,
    });
    mediaUrlService = createMediaUrlService({
      mediaObjectService: getMediaObjectService(),
      r2Store: r2PublicUrlStore,
      localUrlResolver: createLocalImageUrlResolver({
        database,
        imageRoot: path.resolve(IMG_PATH),
        publicApiOrigin: baseURL,
      }),
      readMode: config.MEDIA_READ_MODE,
    });
  }
  return mediaUrlService;
}

const publishedImagePromotionService = createPublishedImagePromotionService({
  imageRoot: path.resolve(IMG_PATH),
  writeMode: config.MEDIA_WRITE_MODE,
  writePaused: config.MEDIA_R2_WRITE_PAUSED,
  mediaPromotionService: {
    promote(payload) {
      return getR2PromotionService().promote(payload);
    },
  },
});

module.exports = {
  promotePublishedImages(payload) {
    return publishedImagePromotionService.promotePublishedImages(payload);
  },
  resolveImageUrl(fileId, options) {
    return getMediaUrlService().resolveImageUrl(fileId, options);
  },
  deleteR2ObjectsForFiles(fileIds) {
    return getMediaDeletionService().deleteR2ObjectsForFiles(fileIds);
  },
};
