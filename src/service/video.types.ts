import type { ArticleCleanup, ArticleDatabase, MediaRuntime } from './article/article.types.js';

export type VideoLogger = Pick<Console, 'info' | 'warn' | 'error'>;
export type VideoUrlResolver = Pick<MediaRuntime, 'resolveVideoUrl' | 'resolveVideoPosterUrl'>;

export interface VideoServiceDependencies {
  connection: ArticleDatabase;
  mediaRuntime: Pick<MediaRuntime, 'promotePublishedVideos' | 'deleteR2ObjectsForFiles'>;
  localMediaCleanup: ArticleCleanup;
  logger?: VideoLogger;
}

export interface VideoMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  format: string | null;
}

export interface VideoFileRow extends Record<string, unknown> {
  id?: number | string;
  filename: string;
  poster?: string | null;
  file_type?: string | null;
  transcode_status?: string | null;
}

export interface VideoAssociation {
  success: boolean;
  affectedRows: number;
  deletedCount: number;
}

export interface VideoStore {
  addVideo(userId: unknown, filename: string, mimetype: string, size: number): Promise<{ insertId: number }>;
  updateTranscodeStatus(videoId: number, status: 'pending' | 'processing' | 'completed' | 'failed'): Promise<unknown>;
  updateVideoMetadata(videoId: number, metadata: Partial<VideoMetadata>): Promise<unknown>;
  updateVideoPoster(videoId: number, poster: string): Promise<unknown>;
  promotePublishedVideoIds(videoIds: number[]): Promise<unknown>;
  updateVideoArticle(articleId: string, videoIds: number[], userId: unknown): Promise<VideoAssociation>;
  deleteVideos(videoIds: number[], userId: unknown): Promise<{
    videosToDelete: VideoFileRow[];
    localCleanup: { pendingIds: number[] };
  } | null>;
  getVideoById(videoId: string): Promise<VideoFileRow | undefined>;
}

export interface VideoUpload {
  filename: string;
  mimetype: string;
  size: number;
  path: string;
}

export type VideoEnvelope<T> = { data: T; code: number } | { msg: string; code: number };

export type VideoUploadResult = {
  id: number;
  url: string;
  poster: null;
  filename: string;
  transcodeStatus: 'processing';
};

export interface VideoOperationsDependencies {
  service: VideoStore;
  mediaRuntime: VideoUrlResolver;
  baseURL: string;
  videoRoot: string;
  logger?: VideoLogger;
  runProcess?: (program: 'ffmpeg' | 'ffprobe', args: string[]) => Promise<string>;
  fileExists?: (path: string) => boolean;
  removeFile?: (path: string) => Promise<void>;
}
