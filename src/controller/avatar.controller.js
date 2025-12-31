const avatarService = require('@/service/avatar.service');
const userService = require('@/service/user.service');
const Result = require('@/app/Result');
const { baseURL } = require('@/constants/urls');
const deleteFile = require('@/utils/deleteFile');

/**
 * 头像控制器
 * 职责：处理头像相关的业务逻辑
 * 注：图片逻辑在 image.controller.js，视频逻辑在 video.controller.js
 */
class AvatarController {
  /**
   * 保存头像信息
   */
  saveAvatarInfo = async (ctx, next) => {
    // 1.获取图像数据,注意@koa/multer库也是把文件放到ctx的request对象中的,所以上传的文件在ctx.file中找到
    const userId = ctx.user.id; //由于来到这里,说明用户已验证登陆(授权),所以可以拿到id
    const { filename, mimetype, size } = ctx.file;
    console.log('获取到用户头像数据', userId, ctx.file);

    // 2.将图像数据保存到数据库中
    const result = await avatarService.addAvatar(userId, filename, mimetype, size);

    // 3.保存成功后,则需要把用户头像的地址保存到profile表中的avatar_url中
    if (result) {
      console.log('上传用户头像成功');
      const avatarUrl = `${baseURL}/user/${userId}/avatar`; //注意,把专门获取头像的接口写好
      const savedAvatarUrl = await userService.updateAvatarUrl(avatarUrl, userId);
      ctx.body = savedAvatarUrl ? Result.success(result) : Result.fail('保存头像地址失败!');
    } else {
      ctx.body = Result.fail('上传用户头像失败!');
    }
  };

  /**
   * 删除头像
   */
  deleteAvatar = async (ctx, next) => {
    const { userId } = ctx.params;
    const file = await avatarService.findAvatarById(userId);
    if (file) {
      deleteFile(file, 'avatar');
      await avatarService.deleteAvatar(file.id);
    }
    ctx.body = file ? Result.success(`删除头像${file.filename}成功`) : Result.fail('删除头像失败');
  };
}

module.exports = new AvatarController();
