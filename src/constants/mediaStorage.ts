export const MEDIA_PROVIDER = Object.freeze({
  LOCAL: 'local',
  R2: 'r2',
});

export const MEDIA_VARIANT = Object.freeze({
  ORIGINAL: 'original',
  SMALL: 'small',
  VIDEO: 'video',
  POSTER: 'poster',
});

export const MEDIA_OBJECT_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  DELETING: 'deleting',
  FAILED: 'failed',
});

export const MEDIA_WRITE_MODE = Object.freeze({
  LOCAL: 'local',
  R2_ON_PUBLISH: 'r2_on_publish',
});

export const MEDIA_READ_MODE = Object.freeze({
  LOCAL: 'local',
  R2_PREFERRED: 'r2_preferred',
});

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DEFAULT_R2_HARD_LIMIT_BYTES = 7_000_000_000;
export const DEFAULT_R2_RESUME_LIMIT_BYTES = 6_000_000_000;
export const MEDIA_CAPACITY_ADVISORY_LOCK_KEY = 'coderx:media:r2-capacity';

export type MediaProvider = (typeof MEDIA_PROVIDER)[keyof typeof MEDIA_PROVIDER];
export type MediaVariant = (typeof MEDIA_VARIANT)[keyof typeof MEDIA_VARIANT];
export type MediaObjectStatus = (typeof MEDIA_OBJECT_STATUS)[keyof typeof MEDIA_OBJECT_STATUS];
export type MediaWriteMode = (typeof MEDIA_WRITE_MODE)[keyof typeof MEDIA_WRITE_MODE];
export type MediaReadMode = (typeof MEDIA_READ_MODE)[keyof typeof MEDIA_READ_MODE];
