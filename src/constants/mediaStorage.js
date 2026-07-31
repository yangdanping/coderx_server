const MEDIA_PROVIDER = Object.freeze({
  LOCAL: 'local',
  R2: 'r2',
});

const MEDIA_VARIANT = Object.freeze({
  ORIGINAL: 'original',
  SMALL: 'small',
  VIDEO: 'video',
  POSTER: 'poster',
});

const MEDIA_OBJECT_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  DELETING: 'deleting',
  FAILED: 'failed',
});

const MEDIA_WRITE_MODE = Object.freeze({
  LOCAL: 'local',
  R2_ON_PUBLISH: 'r2_on_publish',
});

const MEDIA_READ_MODE = Object.freeze({
  LOCAL: 'local',
  R2_PREFERRED: 'r2_preferred',
});

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULT_R2_HARD_LIMIT_BYTES = 7_000_000_000;
const DEFAULT_R2_RESUME_LIMIT_BYTES = 6_000_000_000;
const MEDIA_CAPACITY_ADVISORY_LOCK_KEY = 'coderx:media:r2-capacity';

module.exports = {
  DEFAULT_R2_HARD_LIMIT_BYTES,
  DEFAULT_R2_RESUME_LIMIT_BYTES,
  IMMUTABLE_CACHE_CONTROL,
  MEDIA_CAPACITY_ADVISORY_LOCK_KEY,
  MEDIA_OBJECT_STATUS,
  MEDIA_PROVIDER,
  MEDIA_READ_MODE,
  MEDIA_VARIANT,
  MEDIA_WRITE_MODE,
};
