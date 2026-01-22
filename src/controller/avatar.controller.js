const avatarService = require('@/service/avatar.service');
const userService = require('@/service/user.service');
const Result = require('@/app/Result');
const { baseURL } = require('@/constants/urls');
const deleteFile = require('@/utils/deleteFile');
const connection = require('@/app/database');

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

    const conn = await connection.getConnection();
    let oldAvatarFile = null;

    try {
      // 开启事务
      await conn.beginTransaction();

      // 1. 查询旧头像（用于后续物理删除，不在事务中删除物理文件以防回滚）
      oldAvatarFile = await avatarService.findAvatarById(userId);

      // 2. 如果存在旧头像，先在数据库中删除记录
      if (oldAvatarFile) {
        await avatarService.deleteAvatar(oldAvatarFile.id, conn);
      }

      // 3. 将新图像数据保存到数据库中
      const result = await avatarService.addAvatar(userId, filename, mimetype, size, conn);

      // 4. 保存成功后，把用户头像的地址保存到profile表中的avatar_url中
      const avatarUrl = `${baseURL}/user/${userId}/avatar`;
      await userService.updateAvatarUrl(avatarUrl, userId, conn);

      // 提交事务
      await conn.commit();
      console.log('上传用户头像成功 (事务提交)');

      // 5. 事务提交成功后，异步删除旧头像的物理文件
      if (oldAvatarFile) {
        deleteFile(oldAvatarFile, 'avatar');
      }

      // 返回结果，包含最新的 avatarUrl
      ctx.body = Result.success({
        ...result,
        avatarUrl,
      });
    } catch (error) {
      // 回滚事务
      await conn.rollback();
      console.error('上传头像失败 (事务回滚):', error);
      // 如果事务回滚，说明新上传的文件虽然在磁盘上但数据库没记录，应该删除新文件
      // 这里 ctx.file 是 multer 处理好的，如果业务逻辑失败，建议清理该文件
      // 构造一个类似 file 对象的结构来复用 deleteFile 工具，或者直接用 fs.unlink
      // 这里简单处理：
      const newFile = { filename, mimetype };
      deleteFile(newFile, 'avatar');

      throw error;
    } finally {
      conn.release();
    }
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
