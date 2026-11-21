export const MAX_IMAGE_BATCH_COUNT = 20;
export const MAX_IMAGE_FILE_SIZE_MB = 20;
export const MAX_IMAGE_FILE_SIZE = MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024;

export const MAX_VIDEO_FILE_SIZE_MB = 20;
export const MAX_VIDEO_FILE_SIZE = MAX_VIDEO_FILE_SIZE_MB * 1024 * 1024;

export const MAX_ARTICLE_VIDEO_COUNT = 2;

export const MAX_FLOW_IMAGE_COUNT = 9;
export const MAX_FLOW_IMAGE_FILE_SIZE_MB = 10;
export const MAX_FLOW_IMAGE_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FLOW_IMAGE_PIXELS = 40_000_000;
export const FLOW_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const FLOW_IMAGE_FORMAT_LIMIT_MESSAGE = '图片必须是 JPEG、PNG 或 WebP 格式';
export const FLOW_IMAGE_SIZE_LIMIT_MESSAGE = `图片大小不能超过 ${MAX_FLOW_IMAGE_FILE_SIZE_MB}MB`;

export const IMAGE_TYPE_LIMIT_MESSAGE = '只能上传图片文件';
export const IMAGE_SIZE_LIMIT_MESSAGE = `图片大小不能超过 ${MAX_IMAGE_FILE_SIZE_MB}MB`;
export const IMAGE_BATCH_COUNT_LIMIT_MESSAGE = `单次最多只能上传 ${MAX_IMAGE_BATCH_COUNT} 张图片`;
export const VIDEO_TYPE_LIMIT_MESSAGE = '只能上传视频文件';
export const VIDEO_SIZE_LIMIT_MESSAGE = `视频大小不能超过 ${MAX_VIDEO_FILE_SIZE_MB}MB`;
export const VIDEO_COUNT_LIMIT_MESSAGE = `每篇文章最多只能上传 ${MAX_ARTICLE_VIDEO_COUNT} 个视频`;
