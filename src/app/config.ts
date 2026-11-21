import {
  DEFAULT_R2_HARD_LIMIT_BYTES,
  DEFAULT_R2_RESUME_LIMIT_BYTES,
  MEDIA_READ_MODE,
  MEDIA_WRITE_MODE,
} from '../constants/mediaStorage.js';

export function readMediaConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    readMode: env.MEDIA_READ_MODE || MEDIA_READ_MODE.LOCAL,
    writeMode: env.MEDIA_WRITE_MODE || MEDIA_WRITE_MODE.LOCAL,
    writePaused: env.MEDIA_R2_WRITE_PAUSED === 'true',
    mutationsPaused: env.MEDIA_MUTATIONS_PAUSED === 'true',
    cdnBaseUrl: env.MEDIA_CDN_BASE_URL || 'https://media.ydp321.asia',
    bucket: env.R2_BUCKET || 'coderx-media-public',
    accountId: env.R2_ACCOUNT_ID || '',
    accessKeyId: env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
    hardLimitBytes: Number(env.R2_HARD_LIMIT_BYTES || DEFAULT_R2_HARD_LIMIT_BYTES),
    resumeLimitBytes: Number(env.R2_RESUME_LIMIT_BYTES || DEFAULT_R2_RESUME_LIMIT_BYTES),
  };
}
