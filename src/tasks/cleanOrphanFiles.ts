import type { DatabaseAdapter, DatabaseTransaction } from '../app/database/database.types.js';
import type { ArticleCleanup, MediaRuntime } from '../service/article/article.types.js';
import SqlUtils from '../utils/SqlUtils.js';
import { buildDeleteConsumedDraftsSql, buildDeleteDiscardedDraftsSql, buildDeleteExpiredActiveDraftsSql, buildFindOrphanFilesSql } from './cleanOrphanFiles.sql.js';

interface CleanupTask {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

export interface CleanupDependencies {
  cron: {
    createTask(expression: string, callback: () => Promise<void>, options: { timezone: string; noOverlap: boolean }): CleanupTask;
  };
  connection: Pick<DatabaseAdapter, 'getConnection'>;
  mediaRuntime: Pick<MediaRuntime, 'deleteR2ObjectsForFiles'>;
  localMediaCleanup: Pick<ArticleCleanup, 'buildLocalCleanupEntries' | 'enqueueInTransaction'> & {
    processPending(options?: { ids: number[] }): Promise<{ deleted: number; missing: number }>;
  };
}

type FileType = 'image' | 'video';
type OrphanFile = Parameters<ArticleCleanup['buildLocalCleanupEntries']>[0][number] & {
  id: number | string;
  size: number | string | null;
  age_in_units: number;
  transcode_status?: string | null;
};

const cleanupConfig = {
  test: {
    cronExpression: '0 */1 * * *',
    fileAge: 10,
    draftAges: { consumed: 3, discarded: 3, active: 10 },
    unit: 'SECOND',
    unitLabel: '秒',
  },
  prod: {
    cronExpression: '0 2 * * *',
    fileAge: 7,
    draftAges: { consumed: 1, discarded: 1, active: 7 },
    unit: 'DAY',
    unitLabel: '天',
  },
};
const fileTypeNames = { image: '图片', video: '视频' };

const draftCleanupSteps = [
  ['consumed', buildDeleteConsumedDraftsSql],
  ['discarded', buildDeleteDiscardedDraftsSql],
  ['active', buildDeleteExpiredActiveDraftsSql],
] as const;

function getMutationCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== 'object') return 0;
  return Number(('affectedRows' in result ? result.affectedRows : undefined) ?? ('rowCount' in result ? result.rowCount : undefined) ?? 0);
}

function isOrphanFile(row: unknown): row is OrphanFile {
  return (
    row !== null &&
    typeof row === 'object' &&
    'id' in row &&
    (typeof row.id === 'number' || typeof row.id === 'string') &&
    'size' in row &&
    (row.size === null || typeof row.size === 'number' || typeof row.size === 'string') &&
    'age_in_units' in row &&
    typeof row.age_in_units === 'number' &&
    (!('filename' in row) || row.filename == null || typeof row.filename === 'string') &&
    (!('file_type' in row) || row.file_type == null || typeof row.file_type === 'string') &&
    (!('poster' in row) || row.poster == null || typeof row.poster === 'string') &&
    (!('transcode_status' in row) || row.transcode_status == null || typeof row.transcode_status === 'string')
  );
}

function createCleanupOperations({ connection, mediaRuntime, localMediaCleanup }: CleanupDependencies, mode: string) {
  if (mode !== 'test' && mode !== 'prod') throw new Error('CLEAN_CRON_MODE must be test or prod');
  const { cronExpression, draftAges, fileAge, unit, unitLabel } = cleanupConfig[mode];

  async function cleanLifecycleDrafts(conn: DatabaseTransaction) {
    for (const [key, buildSql] of draftCleanupSteps) {
      const [deleteResult] = await conn.execute(buildSql(unit), [draftAges[key]]);
      console.log(`📝 已清理 ${key} 草稿: ${getMutationCount(deleteResult)} 条`);
    }
  }

  async function cleanLifecycleDraftsOnce() {
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      await cleanLifecycleDrafts(conn);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      console.error('❌ 清理 draft lifecycle 失败:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  async function cleanOrphanFiles(fileType: FileType, _method: 'cron' | 'manual' = 'cron', { skipDraftCleanup = false } = {}) {
    if (fileType !== 'image' && fileType !== 'video') throw new Error(`不支持的文件类型: ${fileType}`);
    const name = fileTypeNames[fileType];
    console.log(`\n🧹 ==================== 开始清理孤儿${name} ====================`);
    console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'));

    const conn = await connection.getConnection();
    console.log(`🔍 清理阈值: ${fileAge}${unitLabel}前创建的文件`);
    let committed = false;
    try {
      await conn.beginTransaction();
      if (!skipDraftCleanup) await cleanLifecycleDrafts(conn);

      const [orphanFiles] = await conn.execute(buildFindOrphanFilesSql(fileType, unit), [fileType, fileAge]);
      if (!Array.isArray(orphanFiles) || !orphanFiles.every(isOrphanFile)) throw new TypeError('Orphan file query returned invalid rows');
      if (orphanFiles.length === 0) {
        console.log(`ℹ️ 没有需要清理的孤儿${name}`);
        await conn.commit();
        return;
      }

      const activeVideo = fileType === 'video' && orphanFiles.find((file) => file.transcode_status === 'pending' || file.transcode_status === 'processing');
      if (activeVideo) throw new Error(`拒绝清理仍在转码中的视频（ID: ${activeVideo.id}）`);

      console.log(`📊 找到 ${orphanFiles.length} 个孤儿${name}需要清理:`);
      orphanFiles.forEach((file, index) => {
        console.log(`   ${index + 1}. ID: ${file.id}, 文件: ${file.filename}, 创建于: ${file.age_in_units} ${unitLabel}前`);
      });

      // R2 删除或推广未完成时保留本地文件及记录供重试。
      const fileIds = orphanFiles.map((file) => file.id);
      await mediaRuntime.deleteR2ObjectsForFiles(fileIds);
      // 本地清理 outbox 和孤儿行删除使用同一事务。
      const cleanupIds = await localMediaCleanup.enqueueInTransaction(conn, localMediaCleanup.buildLocalCleanupEntries(orphanFiles));
      const [deleteResult] = await conn.execute(`DELETE FROM file WHERE ${SqlUtils.queryIn('id', fileIds)}`, fileIds);
      await conn.commit();
      committed = true;

      const localCleanup = await localMediaCleanup.processPending({ ids: cleanupIds });
      console.log(`✅ 清理完成! 删除了 ${localCleanup.deleted + localCleanup.missing} 个本地文件，${getMutationCount(deleteResult)} 条数据库记录`);
      const totalSize = orphanFiles.reduce((sum, file) => sum + Number(file.size), 0);
      console.log(`💾 释放存储空间: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) {
      if (!committed) await conn.rollback();
      console.error(`❌ 清理孤儿${name}失败:`, error);
    } finally {
      conn.release();
      console.log('==================== 清理任务结束 ====================\n');
    }
  }

  return {
    cleanOrphanFiles,
    cleanOrphanImages: () => cleanOrphanFiles('image'),
    cleanOrphanVideos: () => cleanOrphanFiles('video'),
    cleanLifecycleDraftsOnce,
    async runNow() {
      console.log('🚀 手动触发清理任务...');
      await cleanOrphanFiles('image');
    },
    cronExpression,
  };
}

export function createBackgroundJobs(enabled: true, load: () => CleanupDependencies, mode?: string): ReturnType<typeof createJobs>;
export function createBackgroundJobs(enabled: boolean, load: () => CleanupDependencies, mode?: string): ReturnType<typeof createJobs> | null;
export function createBackgroundJobs(enabled: boolean, load: () => CleanupDependencies, mode = process.env.CLEAN_CRON_MODE || 'prod') {
  if (enabled === false) return null;
  if (enabled !== true) throw new TypeError('enabled must be a boolean');
  return createJobs(load(), mode);
}

function createJobs(deps: CleanupDependencies, mode: string) {
  const operations = createCleanupOperations(deps, mode);
  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const inflight = new Set<Promise<unknown>>();

  function track<T>(work: () => Promise<T>) {
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(work());
    } catch (error) {
      promise = Promise.reject(error);
    }
    inflight.add(promise);
    void promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise),
    );
    return promise;
  }

  function retryPending() {
    void track(() => deps.localMediaCleanup.processPending()).catch((error: unknown) => {
      console.error('❌ 启动时重试本地媒体清理失败:', error instanceof Error ? error.message : String(error));
    });
  }

  const task = deps.cron.createTask(
    operations.cronExpression,
    () =>
      stopped
        ? Promise.resolve()
        : track(async () => {
            await deps.localMediaCleanup.processPending();
            await operations.cleanLifecycleDraftsOnce();
            await operations.cleanOrphanFiles('image', 'cron', { skipDraftCleanup: true });
            await operations.cleanOrphanFiles('video', 'cron', { skipDraftCleanup: true });
          }),
    { timezone: 'Asia/Shanghai', noOverlap: true },
  );

  return {
    ...operations,
    task,
    start() {
      if (started || stopped) return;
      started = true;
      const starting = task.start();
      if (starting)
        return track(async () => {
          await starting;
          if (!stopped) retryPending();
        });
      retryPending();
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      stopping = (async () => {
        try {
          if (started) await task.stop();
        } finally {
          await Promise.allSettled([...inflight]);
          await task.destroy?.();
        }
      })();
      return stopping;
    },
  };
}
