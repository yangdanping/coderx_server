import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { ImageService } from '../service/image/image.service.js';
import { saveUploadedImages } from '../service/image/imageUpload.service.js';
import { bodyFields } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: associationHandlers } = createFactory<AppEnv, '/img/:articleId'>();

function uploadedImages(value: unknown) {
  if (!Array.isArray(value)) return null;
  const images = value.map(bodyFields);
  if (!images.every((image): image is { id: number; isCover?: unknown } =>
    typeof image.id === 'number' && Number.isSafeInteger(image.id) && image.id > 0)) return null;
  return images;
}

type ImageControllerService = Pick<ImageService, 'addImage' | 'updateImageArticle' | 'deleteOwnedUnattachedImages'>;

export function createImageController(service: ImageControllerService, publicApiOrigin: string) {
  return {
    saveImages: createHandlers(async c => {
      const files = c.get('diskUploads');
      if (!files) throw new TypeError("Cannot read properties of undefined (reading 'length')");
      const images = await saveUploadedImages(service, authUserId(c.get('user')), files, publicApiOrigin);
      return legacyJson(c, images.length ? Result.success(images) : Result.fail('保存图片失败'));
    }),
    associateImages: associationHandlers(async c => {
      const images = uploadedImages(bodyFields(c.get('parsedBody')).uploaded);
      if (!images) return legacyJson(c, Result.fail('上传数据格式错误'));
      const userId = authUserId(c.get('user'));
      const imageIds = images.map(image => image.id);
      const coverImageId = images.find(image => image.isCover === true)?.id ?? null;
      const result = await service.updateImageArticle(userId, c.req.param('articleId'), imageIds, coverImageId);
      return legacyJson(c, Result.success(result));
    }),
    deleteImages: createHandlers(async c => {
      const images = uploadedImages(bodyFields(c.get('parsedBody')).uploaded);
      if (!images) return legacyJson(c, Result.fail('上传数据格式错误'));
      const { imagesToDelete, localCleanup } = await service.deleteOwnedUnattachedImages(
        authUserId(c.get('user')), images.map(image => image.id),
      );
      if (localCleanup?.pendingIds?.length) {
        console.warn(`${localCleanup.pendingIds.length} 个本地图片文件已进入持久化重试队列`);
      }
      return legacyJson(c, Result.success(`已删除${imagesToDelete.length}张图片成功`));
    }),
  };
}
