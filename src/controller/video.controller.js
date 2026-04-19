const videoService = require('@/service/video.service');
const Result = require('@/app/Result');
const BusinessError = require('@/errors/BusinessError');
const { baseURL } = require('@/constants/urls');
const { MAX_ARTICLE_VIDEO_COUNT, VIDEO_COUNT_LIMIT_MESSAGE } = require('@/constants/upload');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * 视频控制器
 * 处理视频上传、删除、关联等业务逻辑
 */
class VideoController {
  /**
   * 保存视频信息并触发后台元数据采集流水线
   */
  saveVideoInfo = async (ctx, next) => {
    const userId = ctx.user.id;
    // multer 未写入 ctx.file 时（multipart 字段名不匹配、前端未带文件等）直接报 400，
    // 而不是因解构 undefined 抛 TypeError 让错误中间件兜成 500
    if (!ctx.file) {
      throw new BusinessError('缺少视频文件', 400, 400);
    }
    const { filename, mimetype, size, path: videoPath } = ctx.file;

    console.log('📹 获取到视频数据', { userId, filename, mimetype, size, videoPath });

    // 1. 先保存视频基本信息到数据库（video_meta.transcode_status 默认 'pending'）
    const result = await videoService.addVideo(userId, filename, mimetype, size);

    const videoId = result.insertId;
    const videoUrl = `${baseURL}/article/video/${filename}`;

    // 2. 立即把状态推进到 processing
    //    此处先于后台流水线 await 一次，目的是让「入库成功但 ffmpeg 未跑」这类异常更容易定位：
    //    只要 DB 里出现了 processing 但长期停留不变，就说明后台任务根本没启动
    await videoService.updateTranscodeStatus(videoId, 'processing');

    const posterFilename = `${path.parse(filename).name}-poster.jpg`;
    const outputFolder = path.resolve('./public/video');

    console.log(`🎬 [视频 ${videoId}] 准备启动后台流水线:`, {
      videoPath,
      posterFilename,
      outputFolder,
    });

    if (!fs.existsSync(videoPath)) {
      console.error(`❌ [视频 ${videoId}] 视频文件不存在:`, videoPath);
      throw new Error('视频文件不存在');
    }

    // 3. fire-and-forget 启动流水线：内部自行捕获异常并落地 failed 状态，不会阻塞响应
    this.processVideoAsset(videoPath, posterFilename, outputFolder, videoId);

    // 4. 立即返回响应（元数据 + 封面在后台补齐，前端可通过 GET /video/:videoId 轮询进度）
    const posterUrl = `${baseURL}/article/video/${posterFilename}`;
    ctx.body = Result.success({
      id: videoId,
      url: videoUrl,
      poster: posterUrl,
      filename: filename,
      transcodeStatus: 'processing',
    });
  };

  /**
   * 视频后台处理流水线
   *
   * 并行跑 ffprobe（采集元数据）+ ffmpeg（截封面），任一成功都会写库，整体链路失败则落 failed。
   * 状态机：pending(入库默认) -> processing(入口即推进) -> completed / failed
   *
   * @param {string} videoPath - 视频文件路径
   * @param {string} posterFilename - 封面文件名
   * @param {string} outputFolder - 输出目录
   * @param {number} videoId - 视频ID
   * @returns {Promise<void>}
   */
  processVideoAsset = async (videoPath, posterFilename, outputFolder, videoId) => {
    try {
      // saveVideoInfo 已经 set 过 processing，这里再 set 一次保证幂等：
      // 即使将来有别的入口（比如补跑脚本）直接调用 processVideoAsset，也能正确标记
      await videoService.updateTranscodeStatus(videoId, 'processing');

      const [metadata] = await Promise.all([
        this.probeVideo(videoPath),
        this.runFfmpegScreenshot(videoPath, posterFilename, outputFolder, videoId),
      ]);

      await videoService.updateVideoMetadata(videoId, metadata);
      await videoService.updateVideoPoster(videoId, posterFilename);
      await videoService.updateTranscodeStatus(videoId, 'completed');

      console.log(`✅ [视频 ${videoId}] 流水线完成: metadata + poster 已写库`, metadata);
    } catch (err) {
      console.error(`❌ [视频 ${videoId}] 流水线失败:`, err.message);
      // 状态兜底：哪怕 update 失败也只记日志，不再外抛（流水线本身就是 fire-and-forget）
      await videoService.updateTranscodeStatus(videoId, 'failed').catch((statusErr) => {
        console.error(`❌ [视频 ${videoId}] 标记 failed 亦失败:`, statusErr.message);
      });
    }
  };

  /**
   * 使用 ffprobe 采集视频元数据
   *
   * 等价命令：ffprobe -v error -show_format -show_streams -print_format json <videoPath>
   * 返回字段已做 CHECK 约束兼容：format 截断到 20 字符以内。
   *
   * @param {string} videoPath - 视频文件路径
   * @returns {Promise<{duration:number|null, width:number|null, height:number|null, bitrate:number|null, format:string|null}>}
   */
  probeVideo = (videoPath) => {
    return new Promise((resolve, reject) => {
      const args = ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', videoPath];
      const proc = spawn('ffprobe', args);

      let stdoutOutput = '';
      let stderrOutput = '';
      proc.stdout.on('data', (chunk) => {
        stdoutOutput += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString();
      });

      proc.on('error', (err) => reject(err));

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffprobe exited with code ${code}: ${stderrOutput.trim()}`));
        }

        let parsed;
        try {
          parsed = JSON.parse(stdoutOutput);
        } catch (parseErr) {
          return reject(new Error(`ffprobe JSON parse failed: ${parseErr.message}`));
        }

        const fmt = parsed.format || {};
        const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video') || {};

        const durationNum = Number(fmt.duration);
        const duration = Number.isFinite(durationNum) ? Math.round(durationNum) : null;

        const bitRateNum = Number(fmt.bit_rate);
        // 统一按 kbps 存库，便于前端直接展示
        const bitrate = Number.isFinite(bitRateNum) ? Math.round(bitRateNum / 1000) : null;

        const width = Number.isInteger(videoStream.width) ? videoStream.width : null;
        const height = Number.isInteger(videoStream.height) ? videoStream.height : null;

        // format_name 可能是 "mov,mp4,m4a,3gp,3g2,mj2" 这种逗号串，取第一个并截断，满足 CHECK length(format) <= 20
        let formatName = null;
        if (typeof fmt.format_name === 'string' && fmt.format_name.length > 0) {
          formatName = fmt.format_name.split(',')[0].slice(0, 20);
        }

        resolve({ duration, width, height, bitrate, format: formatName });
      });
    });
  };

  /**
   * 使用 ffmpeg 生成视频封面截图（只负责产出物理文件，不再直接写库）
   *
   * 等价命令：ffmpeg -y -ss 1 -i <videoPath> -frames:v 1 -vf scale=640:-2 <posterPath>
   *
   * @param {string} videoPath - 视频文件路径
   * @param {string} posterFilename - 封面文件名
   * @param {string} outputFolder - 输出目录
   * @param {number} videoId - 视频ID
   * @returns {Promise<string>} 生成成功的封面绝对路径
   */
  runFfmpegScreenshot = (videoPath, posterFilename, outputFolder, videoId) => {
    return new Promise((resolve, reject) => {
      console.log(`⏳ [视频 ${videoId}] 开始生成封面...`);

      const posterPath = path.join(outputFolder, posterFilename);
      // -ss 放在 -i 前是快速 seek；-vf scale=640:-2 让高度保持偶数，编码友好
      const args = ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', posterPath];

      console.log(`🎯 [视频 ${videoId}] FFmpeg 命令:`, 'ffmpeg', args.join(' '));

      const proc = spawn('ffmpeg', args);

      let stderrOutput = '';
      proc.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString();
      });

      proc.on('error', (err) => {
        console.error(`❌ [视频 ${videoId}] 无法启动 ffmpeg:`, err.message);
        reject(err);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`❌ [视频 ${videoId}] 生成封面失败 (exit=${code})`);
          if (stderrOutput) {
            console.error(`❌ [视频 ${videoId}] FFmpeg stderr:`, stderrOutput);
          }
          return reject(new Error(`ffmpeg exited with code ${code}`));
        }

        console.log(`✅ [视频 ${videoId}] 封面生成成功:`, posterFilename);
        resolve(posterPath);
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
   *
   * 鉴权策略（防越权）：
   * 1. 先把 videoIds 归一化成正整数集合（去重、过滤非法值）
   * 2. 通过 findVideosByIds(ids, userId) 查询——SQL 内已带 user_id 过滤，
   *    若返回条数 < 请求条数，说明 ID 不存在或不属于当前用户，整批拒绝
   *    （全有或全无，避免「能删几个就删几个」的部分成功语义）
   * 3. deleteVideos(ids, userId) 再次在 DELETE 语句里校验 user_id，双重兜底
   */
  deleteVideo = async (ctx, next) => {
    const userId = ctx.user.id;
    const { videoIds } = ctx.request.body;

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      ctx.body = Result.fail('参数错误: videoIds 必须是非空数组');
      return;
    }

    const normalizedIds = Array.from(new Set(videoIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    if (normalizedIds.length === 0) {
      ctx.body = Result.fail('参数错误: videoIds 必须是有效的正整数数组');
      return;
    }

    // 1. 查询归属当前用户的视频信息
    const videos = await videoService.findVideosByIds(normalizedIds, userId);

    // 2. 归属校验：条数不匹配即认为存在越权或无效 ID，整批拒绝
    if (videos.length !== normalizedIds.length) {
      console.warn(`⚠️ 用户 ${userId} 尝试删除非归属或不存在的视频:`, {
        requested: normalizedIds,
        matched: videos.map((v) => v.id),
      });
      ctx.body = Result.fail('无权删除部分视频，或视频不存在');
      return;
    }

    // 3. 删除物理文件（包括视频和封面）
    videos.forEach((video) => {
      const videoPath = path.join('./public/video', video.filename);
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
        console.log(`🗑️ 已删除视频文件: ${video.filename}`);
      }

      if (video.poster) {
        const posterPath = path.join('./public/video', video.poster);
        if (fs.existsSync(posterPath)) {
          fs.unlinkSync(posterPath);
          console.log(`🗑️ 已删除视频封面: ${video.poster}`);
        }
      }
    });

    // 4. 删除数据库记录（DELETE 里再次带 user_id 作第二道防线）
    await videoService.deleteVideos(normalizedIds, userId);

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
