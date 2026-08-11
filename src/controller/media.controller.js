const Result = require('@/app/Result');
const BusinessError = require('@/errors/BusinessError');
const mediaImageService = require('@/service/mediaImage.service');

function normalizePositiveId(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new BusinessError(`参数错误: ${name} 必须是正整数`, 400);
  }
  return normalized;
}

class MediaController {
  uploadImage = async (ctx) => {
    const asset = await mediaImageService.createPendingImage(ctx.user.id, ctx.file);
    ctx.body = Result.success(asset);
  };

  deleteImage = async (ctx) => {
    const mediaId = normalizePositiveId(ctx.params.mediaId, 'mediaId');
    const result = await mediaImageService.deletePendingImage(ctx.user.id, mediaId);
    ctx.body = Result.success(result);
  };
}

module.exports = new MediaController();
