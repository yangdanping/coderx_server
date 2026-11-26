import { createLocalImageUrlResolver } from '../localImageUrlResolver.service.js';
import { createMediaObjectService } from '../mediaObject.service.js';
import { createMediaUrlService } from '../mediaUrl.service.js';
import type { DatabaseAdapter } from '../../app/database/database.types.js';
import type { ImageVariant } from './mediaImage.service.js';

type Config = {
  imageRoot: string;
  publicApiOrigin: string;
  readMode: string;
  bucket: string;
  cdnBaseUrl: string;
  hardLimitBytes: number;
};

export function createMediaImageUrlResolver(database: DatabaseAdapter, config: Config) {
  let service: ReturnType<typeof createMediaUrlService> | undefined;

  return async (fileId: number, options: { variant: ImageVariant }): Promise<unknown> => {
    if (!service) {
      const { createR2MediaStore } = await import('../../storage/r2MediaStore.js');
      const resolveLocalImage = createLocalImageUrlResolver({
        database,
        imageRoot: config.imageRoot,
        publicApiOrigin: config.publicApiOrigin,
      });
      service ??= createMediaUrlService({
        mediaObjectService: createMediaObjectService({ database, hardLimitBytes: config.hardLimitBytes }),
        localUrlResolver(fileId, variant) {
          if (variant === 'video' || variant === 'poster') return null;
          return resolveLocalImage(fileId, variant);
        },
        readMode: config.readMode,
        r2Store: createR2MediaStore({
          client: { async send() { throw new Error('The CDN URL resolver must not call the R2 S3 API'); } },
          bucket: config.bucket,
          publicBaseUrl: config.cdnBaseUrl,
        }),
      });
    }
    return service.resolveImageUrl(fileId, options);
  };
}
