const fileService = require('../service/file.service');
const userService = require('../service/user.service');
const config = require('../app/config');
const Result = require('../app/Result');
const { baseURL } = require('../constants/urls');
const deleteFile = require('../utils/deleteFile');

class FileController {
  async saveAvatarInfo(ctx, next) {
    // 1.获取图像数据,注意@koa/multer库也是把文件放到ctx的request对象中的,所以上传的文件在ctx.file中找到
    const userId = ctx.user.id; //由于来到这里,说明用户已验证登陆(授权),所以可以拿到id
    const { filename, mimetype, size } = ctx.file;
    console.log('获取到用户头像数据', userId, ctx.file);
    // 2.将图像数据保存到数据库中
    const result = await fileService.addAvatar(userId, filename, mimetype, size);
    // // 3.保存成功后,则需要把用户头像的地址保存到profile表中的avatar_url中
    if (result) {
      console.log('上传用户头像成功');
      const avatarUrl = `${baseURL}/user/${userId}/avatar`; //注意,把专门获取头像的接口写好
      const savedAvatarUrl = await userService.updateAvatarUrl(avatarUrl, userId);
      ctx.body = savedAvatarUrl ? Result.success(result) : Result.fail('保存头像地址失败!');
    } else {
      ctx.body = Result.fail('上传用户头像失败!');
    }
  }
  async savePictureInfo(ctx, next) {
    // 1.获取图像数据,由于那边是multer({ ... }).array('picture', 9),所以这里是返回数组,是files
    const userId = ctx.user.id;
    const files = ctx.files;
    // const { articleId } = ctx.query;
    // 2.将所有的文件信息报尺寸到数据库中
    /* 注意为了能够知道图像是属于哪条动态的,必须在前端那边定义个query拿到articleId */
    const savedPictures = [];
    for (const file of files) {
      const { filename, mimetype, size } = file;
      const result = await fileService.addFile(userId, filename, mimetype, size);
      if (result) {
        const obj = {
          result,
          url: `${baseURL}/article/images/${filename}`
        };
        savedPictures.push(obj);
      } else {
        Result.fail('保存图片失败');
      }
    }
    ctx.body = Result.success(savedPictures);
  }

  async updateFile(ctx, next) {
    const { articleId } = ctx.params;
    const { uploaded } = ctx.request.body;
    const uploadedId = uploaded.map((img) => img.id);
    const result = await fileService.updateFile(articleId, uploadedId);
    console.log('updateFile', result);
    const { id } = uploaded.find((img) => img.isCover);
    if (id) {
      await fileService.updateCover(articleId, id);
    }
    ctx.body = result ? Result.success(result) : Result.fail('上传文章配图失败!');
  }
  async deleteFile(ctx, next) {
    const { uploaded } = ctx.request.body;
    const uploadedId = uploaded.map((img) => img.id);
    const files = await fileService.findFileById(uploadedId);
    files.length && deleteFile(files);
    await fileService.delete(uploadedId);
    ctx.body = files.length ? Result.success(`已删除${files.length}张图片成功`) : Result.fail('删除图片失败');
  }
  async deleteAvatar(ctx, next) {
    const { userId } = ctx.params;
    const file = await fileService.findAvatarById(userId);
    if (file) {
      deleteFile(file, 'avatar');
      await fileService.deleteAvatar(file.id);
    }
    ctx.body = file ? Result.success(`删除头像${file.filename}成功`) : Result.fail('删除头像失败');
  }
}

module.exports = new FileController();
