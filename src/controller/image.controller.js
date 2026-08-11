const imageService = require('@/service/image.service');
const Result = require('@/app/Result');
const { baseURL } = require('@/constants/urls');

/**
 * 图片控制器
 * 职责：处理图片上传、删除、关联等业务逻辑
 * 注：头像相关逻辑在 avatar.controller.js
 */
class ImageController {
  /**
   * 保存图片信息
   * 处理批量图片上传（当前接口最多 20 张）
   */
  saveImgInfo = async (ctx, next) => {
    // 1.获取图像数据,由于那边是 multer({ ... }).array('img', 20),所以这里返回数组 files
    const userId = ctx.user.id;
    const files = ctx.files;

    // 2.将所有的文件信息保存到数据库中（包括图片元数据）
    const savedImgs = [];
    for (const file of files) {
      const { filename, mimetype, size } = file;
      try {
        const result = await imageService.addImage(userId, filename, mimetype, size);
        if (result) {
          const obj = {
            result,
            url: `${baseURL}/article/images/${filename}`,
          };
          savedImgs.push(obj);
        } else {
          console.error('保存图片失败:', filename);
        }
      } catch (error) {
        console.error('保存图片失败:', error);
      }
    }

    if (savedImgs.length > 0) {
      ctx.body = Result.success(savedImgs);
    } else {
      ctx.body = Result.fail('保存图片失败');
    }
  };

  /**
   * 关联图片到文章
   * 用于发布/编辑文章时，将上传的图片与文章关联
   * 仅当前端显式传入封面标记时才设置封面
   */
  updateFile = async (ctx, next) => {
    const userId = ctx.user.id;
    const { articleId } = ctx.params;
    const { uploaded } = ctx.request.body;

    console.log('📝 updateFile - 接收到的数据:', { articleId, uploaded });
    console.log('🔍 updateFile - uploaded 数组详情:', JSON.stringify(uploaded, null, 2));

    if (!Array.isArray(uploaded)) {
      console.error('❌ updateFile - uploaded 不是数组');
      ctx.body = Result.fail('上传数据格式错误');
      return;
    }

    if (uploaded.length === 0) {
      const result = await imageService.updateImageArticle(userId, articleId, [], null);
      ctx.body = Result.success(result);
      return;
    }

    if (!uploaded.every((item) => Number.isSafeInteger(item?.id) && item.id > 0)) {
      console.error('❌ updateFile - uploaded 包含无效图片ID');
      ctx.body = Result.fail('上传数据格式错误');
      return;
    }

    // 提取图片ID和封面ID
    const uploadedIds = uploaded.map((img) => img.id);
    const coverImage = uploaded.find((img) => img.isCover === true);
    const coverImageId = coverImage ? coverImage.id : null;

    console.log('📋 updateFile - 处理后的图片 ID 列表:', uploadedIds);
    console.log('🖼️ updateFile - 封面图片ID:', coverImageId);

    try {
      // 使用 imageService.updateImageArticle 方法
      const result = await imageService.updateImageArticle(userId, articleId, uploadedIds, coverImageId);
      console.log('✅ updateFile - 更新成功:', result);

      ctx.body = Result.success(result);
    } catch (error) {
      console.error('❌ updateFile - 更新失败:', error);
      throw error; // 让全局中间件捕捉
    }
  };

  /**
   * 删除图片
   * 删除物理文件和数据库记录
   */
  deleteFile = async (ctx, next) => {
    const userId = ctx.user.id;
    const { uploaded } = ctx.request.body;
    if (!Array.isArray(uploaded) || !uploaded.every((item) => Number.isSafeInteger(item?.id) && item.id > 0)) {
      ctx.body = Result.fail('上传数据格式错误');
      return;
    }
    const uploadedIds = uploaded.map((img) => img.id);

    const { imagesToDelete, localCleanup } = await imageService.deleteOwnedUnattachedImages(userId, uploadedIds);
    if (localCleanup?.pendingIds?.length) {
      console.warn(`${localCleanup.pendingIds.length} 个本地图片文件已进入持久化重试队列`);
    }

    ctx.body = Result.success(`已删除${imagesToDelete.length}张图片成功`);
  };
}

module.exports = new ImageController();
