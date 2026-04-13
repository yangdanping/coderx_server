const imageService = require('@/service/image.service');
const Result = require('@/app/Result');
const { baseURL } = require('@/constants/urls');
const deleteFile = require('@/utils/deleteFile');

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
      const result = await imageService.updateImageArticle(articleId, [], null);
      ctx.body = Result.success(result);
      return;
    }

    // 处理混合格式：{ id, isCover } 或 { url, isCover }
    const processedUploaded = [];

    for (const item of uploaded) {
      if (item.id) {
        // 已有 ID，直接使用
        processedUploaded.push(item);
        console.log(`✅ 使用已有ID: ${item.id}, isCover: ${item.isCover}`);
      } else if (item.url) {
        // 从 URL 提取文件名并查询数据库
        const urlParts = item.url.split('/');
        const filename = urlParts[urlParts.length - 1].split('?')[0]; // 移除查询参数
        console.log(`🔍 从URL提取文件名: ${filename}`);

        try {
          const fileInfo = await imageService.getImageByFilename(filename);
          if (fileInfo && fileInfo.id) {
            processedUploaded.push({ id: fileInfo.id, isCover: item.isCover });
            console.log(`✅ 通过文件名查询到ID: ${fileInfo.id}, isCover: ${item.isCover}`);
          } else {
            console.warn(`⚠️ 未找到文件名对应的记录: ${filename}`);
          }
        } catch (error) {
          console.error(`❌ 查询文件失败: ${filename}`, error);
        }
      }
    }

    if (processedUploaded.length === 0) {
      console.error('❌ updateFile - 没有有效的图片数据');
      ctx.body = Result.fail('没有有效的图片数据');
      return;
    }

    // 提取图片ID和封面ID
    const uploadedIds = processedUploaded.map((img) => img.id);
    const coverImage = processedUploaded.find((img) => img.isCover === true);
    const coverImageId = coverImage ? coverImage.id : null;

    console.log('📋 updateFile - 处理后的图片 ID 列表:', uploadedIds);
    console.log('🖼️ updateFile - 封面图片ID:', coverImageId);

    try {
      // 使用 imageService.updateImageArticle 方法
      const result = await imageService.updateImageArticle(articleId, uploadedIds, coverImageId);
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
    const { uploaded } = ctx.request.body;
    const uploadedId = uploaded.map((img) => img.id);

    // 查询图片信息
    const files = await imageService.findImagesByIds(uploadedId);

    // 删除物理文件
    if (files.length) {
      deleteFile(files);
    }

    // 删除数据库记录（会自动删除 image_meta 记录，因为有外键级联）
    await imageService.deleteImages(uploadedId);

    ctx.body = Result.success(`已删除${files.length}张图片成功`);
  };
}

module.exports = new ImageController();
