import { join, resolve } from 'node:path';
import { DEFAULT_R2_HARD_LIMIT_BYTES, MEDIA_READ_MODE, MEDIA_WRITE_MODE } from '../constants/mediaStorage.js';
import { createBackgroundJobs, type CleanupDependencies } from './cleanOrphanFiles.js';

interface CleanupResources {
  dependencies: CleanupDependencies;
  close(): void | Promise<void>;
}

interface CleanupWorkerOptions {
  env?: NodeJS.ProcessEnv;
  load?: (env: NodeJS.ProcessEnv) => CleanupResources | Promise<CleanupResources>;
}

async function loadCleanupResources(env: NodeJS.ProcessEnv): Promise<CleanupResources> {
  const [
    { createTask },
    { createPgClient },
    {
      default: { sqlLogger },
    },
    { createMediaRuntime },
    { LocalMediaCleanupService, buildLocalCleanupEntries },
  ] = await Promise.all([
    import('node-cron'),
    import('../app/database/pg.factory.js'),
    import('../app/logger.js'),
    import('../service/mediaRuntime.factory.js'),
    import('../service/localMediaCleanup.service.js'),
  ]);
  const database = createPgClient(env, sqlLogger);
  const root = resolve(env.MEDIA_ROOT || 'public');
  const imageRoot = join(root, 'img');
  const videoRoot = join(root, 'video');
  let mediaRuntime: ReturnType<typeof createMediaRuntime> | undefined;

  async function close() {
    try {
      mediaRuntime?.close();
    } finally {
      await database.end();
    }
  }

  try {
    mediaRuntime = createMediaRuntime({
      database,
      imageRoot,
      videoRoot,
      publicApiOrigin: (env.PUBLIC_API_ORIGIN || `${env.APP_HOST}:${env.APP_PORT}`).replace(/\/+$/, ''),
      readMode: env.MEDIA_READ_MODE || MEDIA_READ_MODE.LOCAL,
      writeMode: env.MEDIA_WRITE_MODE || MEDIA_WRITE_MODE.LOCAL,
      writePaused: env.MEDIA_R2_WRITE_PAUSED === 'true',
      bucket: env.R2_BUCKET || 'coderx-media-public',
      cdnBaseUrl: env.MEDIA_CDN_BASE_URL || 'https://media.ydp321.asia',
      hardLimitBytes: Number(env.R2_HARD_LIMIT_BYTES || DEFAULT_R2_HARD_LIMIT_BYTES),
      accountId: env.R2_ACCOUNT_ID || '',
      accessKeyId: env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
    });
    const localCleanup = new LocalMediaCleanupService({ database, roots: { image: imageRoot, video: videoRoot } });
    return {
      dependencies: {
        cron: { createTask },
        connection: database,
        mediaRuntime,
        localMediaCleanup: {
          buildLocalCleanupEntries,
          enqueueInTransaction: (conn, entries) => localCleanup.enqueueInTransaction(conn, entries),
          processPending: (options) => localCleanup.processPending(options),
        },
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function startCleanupWorker({ env = process.env, load = loadCleanupResources }: CleanupWorkerOptions = {}) {
  const enabled = env.CLEANUP_WORKER_ENABLED;
  if (enabled === undefined || enabled === 'false') return null;
  if (enabled !== 'true') throw new Error('CLEANUP_WORKER_ENABLED must be true or false');

  const resources = await load(env);
  let jobs: ReturnType<typeof createBackgroundJobs> | undefined;
  let stopping: Promise<void> | undefined;
  function stop() {
    return (stopping ??= (async () => {
      try {
        await jobs?.stop();
      } finally {
        await resources.close();
      }
    })());
  }

  try {
    jobs = createBackgroundJobs(true, () => resources.dependencies, env.CLEAN_CRON_MODE || 'prod');
    await jobs.start();
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Cleanup worker startup failed');
    }
    throw error;
  }

  return { stop };
}

async function main() {
  const { loadEnvironment } = await import('../app/loadEnvironment.js');
  loadEnvironment();
  const worker = await startCleanupWorker();
  if (!worker) return;

  const onSignal = () => {
    void worker
      .stop()
      .catch(reportError)
      .finally(() => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

function reportError(error: unknown) {
  console.error('Cleanup worker failed:', error);
  process.exitCode = 1;
}

if (import.meta.main) void main().catch(reportError);
