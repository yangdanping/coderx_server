import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, parse } from 'node:path';
import Result from '../app/Result.js';
import BusinessError from '../errors/BusinessError.js';
import { MAX_ARTICLE_VIDEO_COUNT, VIDEO_COUNT_LIMIT_MESSAGE } from '../constants/upload.js';
import { VideoUploadCommitError } from './video.factory.js';
import type { VideoAssociation, VideoEnvelope, VideoFileRow, VideoMetadata, VideoOperationsDependencies, VideoUpload, VideoUploadResult } from './video.types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runVideoProcess(program: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let processError: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { processError = error; });
    child.once('close', (code) => {
      if (processError) return reject(processError);
      if (code !== 0) return reject(new Error(`${program} exited with code ${code}: ${stderr.trim()}`));
      resolve(stdout);
    });
  });
}

function normalizedIds(videoIds: unknown[]) {
  return [...new Set(videoIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

export function createVideoOperations({
  service, mediaRuntime, baseURL, videoRoot, logger = console,
  runProcess = runVideoProcess, fileExists = existsSync, removeFile = (file) => rm(file, { force: true }),
}: VideoOperationsDependencies) {
  const pending = new Set<Promise<unknown>>();
  let stopping = false;

  function track<T>(work: Promise<T>) {
    pending.add(work);
    const settled = () => { pending.delete(work); };
    void work.then(settled, settled);
    return work;
  }
  const localUrl = (filename: string) => `${baseURL}/article/video/${filename}`;

  async function discard(file: string) {
    try {
      await removeFile(file);
    } catch (error) {
      logger.error('清理视频文件失败:', error);
    }
  }

  async function markFailed(videoId: number) {
    try {
      await service.updateTranscodeStatus(videoId, 'failed');
    } catch (error) {
      logger.error(`视频 ${videoId} 标记 failed 失败:`, error);
    }
  }

  async function startUpload(userId: unknown, file: VideoUpload | undefined): Promise<VideoEnvelope<VideoUploadResult>> {
    if (!file) throw new BusinessError('缺少视频文件', 400, 400);
    const { filename, mimetype, size, path: videoPath } = file;
    if (stopping) {
      await discard(videoPath);
      throw new BusinessError('视频上传服务正在关闭，请稍后重试', 503);
    }
    if (!fileExists(videoPath)) throw new Error('视频文件不存在');

    let videoId: number;
    try {
      ({ insertId: videoId } = await service.addVideo(userId, filename, mimetype, size));
    } catch (error) {
      if (!(error instanceof VideoUploadCommitError)) await discard(videoPath);
      throw error;
    }
    try {
      await service.updateTranscodeStatus(videoId, 'processing');
    } catch (error) {
      await markFailed(videoId);
      throw error;
    }

    const posterFilename = `${parse(filename).name}-poster.jpg`;
    const work = track(Promise.resolve(operations.processVideoAsset(videoPath, posterFilename, videoRoot, videoId)));
    void work.catch((error) => logger.error(`视频 ${videoId} 流水线意外终止:`, error));

    const result: VideoUploadResult = { id: videoId, url: localUrl(filename), poster: null, filename, transcodeStatus: 'processing' };
    return Result.success(result);
  }

  const operations = {
    saveUpload(userId: unknown, file: VideoUpload | undefined) {
      // A disconnected socket can finish closing while its INSERT is still running.
      return track(startUpload(userId, file));
    },

    // Call after the HTTP listener has stopped accepting requests.
    async stop() {
      stopping = true;
      // Accepted uploads can register their background work while draining.
      while (pending.size) await Promise.allSettled(pending);
    },

    async processVideoAsset(videoPath: string, posterFilename: string, outputFolder: string, videoId: number): Promise<void> {
      try {
        // Direct callers may also use the same pipeline to retry a video.
        await service.updateTranscodeStatus(videoId, 'processing');
        try {
          const [probe, screenshot] = await Promise.allSettled([
            operations.probeVideo(videoPath),
            operations.runFfmpegScreenshot(videoPath, posterFilename, outputFolder, videoId),
          ]);
          // Both processes have exited before a failed upload becomes eligible for deletion.
          if (probe.status === 'rejected') throw probe.reason;
          if (screenshot.status === 'rejected') throw screenshot.reason;
          await service.updateVideoMetadata(videoId, probe.value);
        } catch (error) {
          await discard(join(outputFolder, posterFilename));
          throw error;
        }
        await service.updateVideoPoster(videoId, posterFilename);
        await service.updateTranscodeStatus(videoId, 'completed');
      } catch (error) {
        logger.error(`视频 ${videoId} 流水线失败:`, error);
        await markFailed(videoId);
        return;
      }

      try {
        const promotion = await service.promotePublishedVideoIds([videoId]);
        logger.info(`视频 ${videoId} 转码后存储晋升结果:`, promotion);
      } catch (error) {
        logger.error(`视频 ${videoId} 转码已完成但存储晋升失败，继续保留本地副本:`, error);
      }
    },

    async probeVideo(videoPath: string): Promise<VideoMetadata> {
      const stdout = await runProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', videoPath]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`ffprobe JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isRecord(parsed)) throw new Error('ffprobe returned a non-object result');
      const format = isRecord(parsed.format) ? parsed.format : {};
      const streams: unknown[] = Array.isArray(parsed.streams) ? parsed.streams : [];
      const stream = streams.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.codec_type === 'video') ?? {};
      const duration = Number(format.duration);
      const bitRate = Number(format.bit_rate);
      return {
        duration: Number.isFinite(duration) ? Math.round(duration) : null,
        width: typeof stream.width === 'number' && Number.isInteger(stream.width) ? stream.width : null,
        height: typeof stream.height === 'number' && Number.isInteger(stream.height) ? stream.height : null,
        bitrate: Number.isFinite(bitRate) ? Math.round(bitRate / 1000) : null,
        format: typeof format.format_name === 'string' && format.format_name.length > 0
          ? format.format_name.split(',')[0].slice(0, 20)
          : null,
      };
    },

    async runFfmpegScreenshot(videoPath: string, posterFilename: string, outputFolder: string, _videoId: number) {
      const posterPath = join(outputFolder, posterFilename);
      // Capture the first frame even for clips shorter than one second.
      await runProcess('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', posterPath]);
      return posterPath;
    },

    async associate(articleId: string, videoIds: unknown, userId: unknown): Promise<VideoEnvelope<VideoAssociation>> {
      if (!Array.isArray(videoIds)) return Result.fail('参数错误: videoIds 必须是数组');
      const ids = normalizedIds(videoIds);
      if (videoIds.length > 0 && ids.length === 0) return Result.fail('参数错误: videoIds 必须是有效的正整数数组');
      if (ids.length > MAX_ARTICLE_VIDEO_COUNT) return Result.fail(VIDEO_COUNT_LIMIT_MESSAGE);
      if (ids.length !== videoIds.length) return Result.fail('参数错误: videoIds 中包含无效视频ID');
      return Result.success(await service.updateVideoArticle(articleId, ids, userId));
    },

    async deleteByIds(videoIds: unknown, userId: unknown): Promise<VideoEnvelope<string>> {
      if (!Array.isArray(videoIds) || videoIds.length === 0) return Result.fail('参数错误: videoIds 必须是非空数组');
      const ids = normalizedIds(videoIds);
      if (ids.length === 0) return Result.fail('参数错误: videoIds 必须是有效的正整数数组');
      const deletion = await service.deleteVideos(ids, userId);
      if (!deletion) throw new Error('deleteVideos did not return a deletion result');
      const { videosToDelete, localCleanup } = deletion;
      if (localCleanup?.pendingIds?.length) logger.warn(`${localCleanup.pendingIds.length} 个本地视频文件已进入持久化重试队列`);
      return Result.success(`已删除${videosToDelete.length}个视频`);
    },

    async getDetail(videoId: string): Promise<VideoEnvelope<VideoFileRow & { url: string }>> {
      const video = await service.getVideoById(videoId);
      if (!video) return Result.fail('视频不存在');
      const posterFilename = typeof video.poster === 'string' ? video.poster.trim() : '';
      const id = Number(video.id ?? videoId);
      const [url, poster] = await Promise.all([mediaRuntime.resolveVideoUrl(id), mediaRuntime.resolveVideoPosterUrl(id)]);
      return Result.success({
        ...video,
        url: url || localUrl(video.filename),
        poster: poster || (posterFilename ? localUrl(posterFilename) : null),
      });
    },
  };
  return operations;
}
