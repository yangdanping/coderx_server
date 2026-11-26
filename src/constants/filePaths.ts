import path from 'node:path';

export const MEDIA_ROOT = path.resolve(process.cwd(), process.env.MEDIA_ROOT || 'public');
export const AVATAR_PATH = path.join(MEDIA_ROOT, 'avatar');
export const IMG_PATH = path.join(MEDIA_ROOT, 'img');
export const VIDEO_PATH = path.join(MEDIA_ROOT, 'video');
