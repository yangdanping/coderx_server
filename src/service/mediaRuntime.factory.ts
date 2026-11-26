import { createLocalImageUrlResolver } from './localImageUrlResolver.service.js';
import { createLocalVideoUrlResolver } from './localVideoUrlResolver.service.js';
import { createMediaDeletionService } from './mediaDeletion.service.js';
import { createMediaObjectService } from './mediaObject.service.js';
import { createMediaPromotionService } from './mediaPromotion.service.js';
import { createMediaUrlService } from './mediaUrl.service.js';
import { createPublishedImagePromotionService } from './publishedImagePromotion.service.js';
import { createPublishedVideoPromotionService } from './publishedVideoPromotion.service.js';
import { createR2Client, createR2MediaStore } from '../storage/r2MediaStore.js';
import type { MediaRuntime, MediaRuntimeDependencies } from './article/article.types.js';

export function createMediaRuntime({
  database,
  imageRoot,
  videoRoot,
  publicApiOrigin,
  readMode,
  writeMode,
  writePaused,
  bucket,
  cdnBaseUrl,
  hardLimitBytes,
  accountId,
  accessKeyId,
  secretAccessKey,
}: MediaRuntimeDependencies) {
  let r2PromotionService: ReturnType<typeof createMediaPromotionService> | undefined;
  let r2Store: ReturnType<typeof createR2MediaStore> | undefined;
  let r2Client: ReturnType<typeof createR2Client> | undefined;
  let mediaObjectService: ReturnType<typeof createMediaObjectService> | undefined;
  let mediaUrlService: ReturnType<typeof createMediaUrlService> | undefined;
  let mediaDeletionService: ReturnType<typeof createMediaDeletionService> | undefined;

  function getMediaObjectService() {
    if (!mediaObjectService) {
      mediaObjectService = createMediaObjectService({
        database,
        hardLimitBytes,
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
        client: (r2Client = createR2Client({
          accountId,
          accessKeyId,
          secretAccessKey,
        })),
        bucket,
        publicBaseUrl: cdnBaseUrl,
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
        bucket,
        publicBaseUrl: cdnBaseUrl,
      });
      const localImageUrlResolver = createLocalImageUrlResolver({
        database,
        imageRoot,
        publicApiOrigin,
      });
      const localVideoUrlResolver = createLocalVideoUrlResolver({
        database,
        publicApiOrigin,
      });
      mediaUrlService = createMediaUrlService({
        mediaObjectService: getMediaObjectService(),
        r2Store: r2PublicUrlStore,
        localUrlResolver(fileId, variant) {
          if (variant === 'video' || variant === 'poster') {
            return localVideoUrlResolver(fileId, variant);
          }
          return localImageUrlResolver(fileId, variant);
        },
        readMode,
      });
    }
    return mediaUrlService;
  }

  const publishedImagePromotionService = createPublishedImagePromotionService({
    imageRoot,
    writeMode,
    writePaused,
    mediaPromotionService: {
      promote(payload) {
        return getR2PromotionService().promote(payload);
      },
    },
  });

  const publishedVideoPromotionService = createPublishedVideoPromotionService({
    videoRoot,
    writeMode,
    writePaused,
    mediaPromotionService: {
      promote(payload) {
        return getR2PromotionService().promote(payload);
      },
    },
  });

  return {
    close() {
      r2Client?.destroy();
    },
    promotePublishedImages(payload) {
      return publishedImagePromotionService.promotePublishedImages(payload);
    },
    promotePublishedVideos(payload) {
      return publishedVideoPromotionService.promotePublishedVideos(payload);
    },
    resolveImageUrl(fileId, options) {
      return getMediaUrlService().resolveImageUrl(fileId, options);
    },
    resolveVideoUrl(fileId) {
      return getMediaUrlService().resolveVideoUrl(fileId);
    },
    resolveVideoPosterUrl(fileId) {
      return getMediaUrlService().resolveVideoPosterUrl(fileId);
    },
    deleteR2ObjectsForFiles(fileIds) {
      return getMediaDeletionService().deleteR2ObjectsForFiles(fileIds);
    },
  } satisfies MediaRuntime;
}
