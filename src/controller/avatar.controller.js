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
  saveAvatarInfo = async (ctx, next) => {
    const userId = ctx.user.id;
    const { filename, mimetype, size } = ctx.file;
    console.log('获取到用户头像数据', userId, ctx.file);

    // 将图像数据保存到数据库中
    const result = await avatarService.addAvatar(userId, filename, mimetype, size);

    // 保存成功后，把用户头像的地址保存到profile表中的avatar_url中
    console.log('上传用户头像成功');
    const avatarUrl = `${baseURL}/user/${userId}/avatar`;
    await userService.updateAvatarUrl(avatarUrl, userId);

    ctx.body = Result.success(result);
  };

  deleteAvatar = async (ctx, next) => {
    const { userId } = ctx.params;
    const file = await avatarService.findAvatarById(userId);

    if (file) {
      deleteFile(file, 'avatar');
      await avatarService.deleteAvatar(file.id);
      ctx.body = Result.success(`删除头像${file.filename}成功`);
    } else {
      ctx.body = Result.success('无头像可删除');
    }
  };
}

module.exports = new AvatarController();
