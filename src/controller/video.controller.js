const videoService = require('@/service/video.service');
const Result = require('@/app/Result');
const { baseURL } = require('@/constants/urls');
const { MAX_ARTICLE_VIDEO_COUNT, VIDEO_COUNT_LIMIT_MESSAGE } = require('@/constants/upload');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

/**
 * 视频控制器
 * 处理视频上传、删除、关联等业务逻辑
 */
class VideoController {
  /**
   * 保存视频信息并生成封面图
   */
  saveVideoInfo = async (ctx, next) => {
    const userId = ctx.user.id;
    const { filename, mimetype, size, path: videoPath } = ctx.file;

    console.log('📹 获取到视频数据', { userId, filename, mimetype, size, videoPath });

    // 1. 先保存视频基本信息到数据库
    const result = await videoService.addVideo(userId, filename, mimetype, size);

    const videoId = result.insertId;
    const videoUrl = `${baseURL}/article/video/${filename}`;

    // 2. 生成视频封面（异步处理）
    const posterFilename = `${path.parse(filename).name}-poster.jpg`;
    const outputFolder = path.resolve('./public/video');

    console.log(`🎬 [视频 ${videoId}] 准备生成封面:`, {
      videoPath,
      posterFilename,
      outputFolder,
    });

    // 确保视频文件存在
    if (!fs.existsSync(videoPath)) {
      console.error(`❌ [视频 ${videoId}] 视频文件不存在:`, videoPath);
      throw new Error('视频文件不存在');
    }

    // 异步生成视频封面 - 使用 Promise 确保可靠性
    this.generateVideoThumbnail(videoPath, posterFilename, outputFolder, videoId)
      .then(() => {
        console.log(`✅ [视频 ${videoId}] 封面生成流程启动成功`);
      })
      .catch((err) => {
        console.error(`❌ [视频 ${videoId}] 封面生成失败:`, err.message);
      });

    // 3. 立即返回响应（封面在后台生成）
    const posterUrl = `${baseURL}/article/video/${posterFilename}`;
    ctx.body = Result.success({
      id: videoId, // 视频ID，用于关联到文章
      url: videoUrl,
      poster: posterUrl, // 返回封面URL（可能稍后才能访问）
      filename: filename, // 视频文件名
    });
  };

  /**
   * 生成视频缩略图
   * @param {string} videoPath - 视频文件路径
   * @param {string} posterFilename - 封面文件名
   * @param {string} outputFolder - 输出目录
   * @param {number} videoId - 视频ID
   * @returns {Promise}
   */
  generateVideoThumbnail = (videoPath, posterFilename, outputFolder, videoId) => {
    return new Promise((resolve, reject) => {
      console.log(`⏳ [视频 ${videoId}] 开始生成封面...`);

      ffmpeg(videoPath)
        .screenshots({
          timestamps: ['00:00:01'], // 提取第1秒的帧
          filename: posterFilename,
          folder: outputFolder,
          size: '640x?', // 宽度640，高度自适应
        })
        .on('start', (commandLine) => {
          console.log(`🎯 [视频 ${videoId}] FFmpeg 命令:`, commandLine);
        })
        .on('end', async () => {
          const posterPath = path.join(outputFolder, posterFilename);
          console.log(`✅ [视频 ${videoId}] 封面生成成功:`, posterFilename);
          console.log(`📁 [视频 ${videoId}] 封面路径:`, posterPath);
          console.log(`✔️ [视频 ${videoId}] 文件存在:`, fs.existsSync(posterPath));

          try {
            // 更新数据库中的封面信息
            await videoService.updateVideoPoster(videoId, posterFilename);
            console.log(`💾 [视频 ${videoId}] 数据库封面信息更新成功`);
            resolve();
          } catch (error) {
            console.error(`❌ [视频 ${videoId}] 更新数据库失败:`, error);
            reject(error);
          }
        })
        .on('error', (err, stdout, stderr) => {
          console.error(`❌ [视频 ${videoId}] 生成封面失败:`, err.message);
          if (stderr) {
            console.error(`❌ [视频 ${videoId}] FFmpeg stderr:`, stderr);
          }
          // 即使封面生成失败，也不阻止视频上传
          reject(err);
        });
    });
  };

  /**
   * 关联视频到文章
   * 用于发布文章时，将上传的视频与文章ID关联
   */
  updateVideoArticle = async (ctx, next) => {
    const { articleId } = ctx.params;
    const { videoIds } = ctx.request.body;

    if (!Array.isArray(videoIds)) {
      ctx.body = Result.fail('参数错误: videoIds 必须是数组');
      return;
    }

    if (videoIds.length === 0) {
      const result = await videoService.updateVideoArticle(articleId, []);
      console.log(`清空文章 ${articleId} 的视频关联`, result);
      ctx.body = Result.success(result);
      return;
    }

    const normalizedVideoIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    if (normalizedVideoIds.length === 0) {
      ctx.body = Result.fail('参数错误: videoIds 必须是有效的正整数数组');
      return;
    }

    if (normalizedVideoIds.length > MAX_ARTICLE_VIDEO_COUNT) {
      ctx.body = Result.fail(VIDEO_COUNT_LIMIT_MESSAGE);
      return;
    }

    const validVideoIds = await videoService.filterValidVideoIds(normalizedVideoIds);
    if (validVideoIds.length !== normalizedVideoIds.length) {
      ctx.body = Result.fail('参数错误: videoIds 中包含无效视频ID');
      return;
    }

    const result = await videoService.updateVideoArticle(articleId, validVideoIds);
    console.log(`关联 ${validVideoIds.length} 个视频到文章 ${articleId}`, result);
    ctx.body = Result.success(result);
  };

  /**
   * 删除视频文件
   */
  deleteVideo = async (ctx, next) => {
    const { videoIds } = ctx.request.body;

    if (!videoIds || !Array.isArray(videoIds)) {
      ctx.body = Result.fail('参数错误');
      return;
    }

    // 1. 查询视频文件信息
    const videos = await videoService.findVideosByIds(videoIds);

    if (!videos || videos.length === 0) {
      ctx.body = Result.fail('视频不存在');
      return;
    }

    // 2. 删除物理文件（包括视频和封面）
    videos.forEach((video) => {
      const videoPath = path.join('./public/video', video.filename);
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
        console.log(`🗑️ 已删除视频文件: ${video.filename}`);
      }

      // 删除封面图
      if (video.poster) {
        const posterPath = path.join('./public/video', video.poster);
        if (fs.existsSync(posterPath)) {
          fs.unlinkSync(posterPath);
          console.log(`🗑️ 已删除视频封面: ${video.poster}`);
        }
      }
    });

    // 3. 删除数据库记录
    await videoService.deleteVideos(videoIds);

    ctx.body = Result.success(`已删除${videos.length}个视频`);
  };

  /**
   * 获取视频信息（用于更新元数据等）
   */
  getVideoInfo = async (ctx, next) => {
    const { videoId } = ctx.params;

    const video = await videoService.getVideoById(videoId);
    if (!video) {
      ctx.body = Result.fail('视频不存在');
      return;
    }
    ctx.body = Result.success(video);
  };
}

module.exports = new VideoController();
