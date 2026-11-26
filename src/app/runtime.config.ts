import path from 'node:path';
import { readMediaConfig } from './config.js';

export function parseBackgroundJobsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('BACKGROUND_JOBS_ENABLED must be true or false');
}

export function parseRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const media = readMediaConfig(env);
  const absolute = (value: string | undefined, fallback: string) => path.resolve(cwd, value || fallback);
  const integer = (value: string | undefined, name: string, min: number, max: number) => {
    if (value === undefined || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} is invalid`);
    return Number(value);
  };
  const hostValue = env.APP_HOST || '127.0.0.1';
  let host = hostValue;
  if (hostValue.includes('://')) {
    try {
      const url = new URL(hostValue);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new Error();
      host = url.hostname;
    } catch { throw new Error('APP_HOST is invalid'); }
  } else if (!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]+)$/.test(hostValue)) {
    throw new Error('APP_HOST is invalid');
  }
  if (host.startsWith('[')) host = host.slice(1, -1);
  return {
    envFile: absolute(env.APP_ENV_FILE, env.NODE_ENV === 'production' ? '.env.production' : '.env.development'),
    host,
    port: integer(env.APP_PORT, 'APP_PORT', 0, 65535),
    mediaRoot: absolute(env.MEDIA_ROOT, 'public'),
    privateKeyPath: absolute(env.JWT_PRIVATE_KEY_PATH, 'src/app/keys/private.key'),
    publicKeyPath: absolute(env.JWT_PUBLIC_KEY_PATH, 'src/app/keys/public.key'),
    logRoot: absolute(env.LOG_ROOT, 'logs'),
    backgroundJobsEnabled: parseBackgroundJobsEnabled(env.BACKGROUND_JOBS_ENABLED),
    buildId: env.BUILD_ID || '',
    frontendUrl: (env.FRONTEND_URL || `${env.APP_HOST}:${env.ASSETS_PORT}`).replace(/\/+$/, ''),
    publicApiOrigin: (env.PUBLIC_API_ORIGIN || `${env.APP_HOST}:${env.APP_PORT}`).replace(/\/+$/, ''),
    mediaMutationsPaused: media.mutationsPaused,
    mediaReadMode: media.readMode,
    mediaCdnBaseUrl: media.cdnBaseUrl,
    r2Bucket: media.bucket,
    r2HardLimitBytes: media.hardLimitBytes,
    shutdownTimeoutMs: integer(env.SHUTDOWN_TIMEOUT_MS ?? '10000', 'SHUTDOWN_TIMEOUT_MS', 1, 2147483647),
  };
}
