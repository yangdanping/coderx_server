import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { createMediaImageDeletionService } from '../service/mediaImage/mediaImageDeletion.service.js';
import { normalizePositiveId, type MediaImageUploadService } from '../service/mediaImage/mediaImage.service.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

type MediaControllerService = Pick<MediaImageUploadService, 'createPendingImage'> & {
  deletePendingImage: ReturnType<typeof createMediaImageDeletionService>;
};

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: deleteHandlers } = createFactory<AppEnv, '/media/images/:mediaId'>();

export function createMediaController(service: MediaControllerService) {
  return {
    uploadImage: createHandlers(async c => {
      const asset = await service.createPendingImage(authUserId(c.get('user')), c.get('mediaImageFile'));
      return legacyJson(c, Result.success(asset));
    }),
    deleteImage: deleteHandlers(async c => {
      const mediaId = normalizePositiveId(c.req.param('mediaId'), 'mediaId');
      const result = await service.deletePendingImage(authUserId(c.get('user')), mediaId);
      return legacyJson(c, Result.success(result));
    }),
  };
}
