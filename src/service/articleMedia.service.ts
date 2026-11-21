import fs from 'node:fs';
import path from 'node:path';

const missing = { status: 404 as const, message: '视频文件不存在' };
const mimeTypes: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

type VideoRange = { start: number; end: number };
type VideoDescription =
  | { status: 416; message: string; contentRange: string }
  | { status: 200; contentType: string; length: number; range?: undefined }
  | { status: 206; contentType: string; length: number; contentRange: string; range: VideoRange };

export function inspectArticleVideo(root: string, filename: string, range?: string) {
  const videoRoot = path.resolve(root);
  // The router already decoded the parameter. Accept only a direct, regular file.
  if (typeof filename !== 'string' || !filename || filename !== path.basename(filename)) return missing;
  const videoPath = path.resolve(videoRoot, filename);
  if (path.dirname(videoPath) !== videoRoot || !fs.existsSync(videoPath) || !fs.lstatSync(videoPath).isFile()) return missing;

  const file = describeArticleVideo(filename, fs.statSync(videoPath).size, range);
  return 'contentType' in file ? { ...file, path: videoPath } : file;
}

export function describeArticleVideo(filename: string, size: number, range?: string): VideoDescription {
  const contentType = mimeTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  if (!range) return { status: 200, contentType, length: size };

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match?.[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || end >= size) {
    return { status: 416, contentRange: `bytes */${size}`, message: 'Range 请求无效' };
  }
  return {
    status: 206,
    contentType,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
    range: { start, end },
  };
}
