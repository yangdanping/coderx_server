/**
 * 孤儿文件定时清理任务
 *
 * 功能：按当前模式先清理过期 lifecycle draft，再清理超过阈值仍未关联到文章的文件（图片、视频等）
 *
 * 使用方法：
 * 1. 安装 node-cron: npm install node-cron
 * 2. 在 src/main.js 中导入并启动：
 *    const cleanOrphanFilesTask = require('./tasks/cleanOrphanFiles');
 *    cleanOrphanFilesTask.start();
 */

const cron = require('node-cron');
const connection = require('@/app/database');
const mediaRuntime = require('@/service/mediaRuntime.service');
const localMediaCleanup = require('@/service/localMediaCleanup.service');
const SqlUtils = require('@/utils/SqlUtils');
const { buildDeleteConsumedDraftsSql, buildDeleteDiscardedDraftsSql, buildDeleteExpiredActiveDraftsSql, buildFindOrphanFilesSql } = require('./cleanOrphanFiles.sql');

// 配置：通过环境变量控制执行频率
// 测试模式：export CLEAN_CRON_MODE=test
// 生产模式：export CLEAN_CRON_MODE=prod （默认）
const CRON_MODE = process.env.CLEAN_CRON_MODE || 'prod';

// 文件清理阈值：active 草稿释放出的文件仍沿用较长 TTL，避免误删正在编辑中的资源
const FILE_CLEANUP_THRESHOLDS = {
  test: {
    interval: 10, // 自定义文件过期时间(秒)
    unit: 'SECOND',
  },
  prod: {
    interval: 7, // 自定义文件过期时间(天) - 延长至 7 天以保护草稿中的文件
    unit: 'DAY',
  },
};

// draft lifecycle 清理阈值：consumed/discarded 更短，active 继续沿用较长 TTL
const DRAFT_CLEANUP_THRESHOLDS = {
  test: {
    consumed: { interval: 3, unit: 'SECOND' },
    discarded: { interval: 3, unit: 'SECOND' },
    active: { interval: 10, unit: 'SECOND' },
  },
  prod: {
    consumed: { interval: 1, unit: 'DAY' },
    discarded: { interval: 1, unit: 'DAY' },
    active: { interval: 7, unit: 'DAY' },
  },
};

const CRON_EXPRESSIONS = {
  // test: `*/3 * * * * *`, // 自定义时间执行（测试用）
  test: `0 */1 * * *`, // 自定义时间执行（测试用）
  prod: `0 2 * * *`, // 每天凌晨 2 点（生产用）
};

// 📁 文件类型配置
const FILE_TYPE_CONFIG = {
  image: {
    name: '图片',
    uploadDir: 'public/img',
  },
  video: {
    name: '视频',
    uploadDir: 'public/video',
  },
};

const unitTextMap = { SECOND: '秒', HOUR: '小时', DAY: '天' };

const getMutationCount = (result) => {
  if (Array.isArray(result)) {
    return result.length;
  }

  if (result && typeof result === 'object') {
    return Number(result.affectedRows ?? result.rowCount ?? 0);
  }

  return 0;
};

const cleanLifecycleDrafts = async (conn, draftThresholds) => {
  const cleanupSteps = [
    {
      key: 'consumed',
      buildSql: buildDeleteConsumedDraftsSql,
    },
    {
      key: 'discarded',
      buildSql: buildDeleteDiscardedDraftsSql,
    },
    {
      key: 'active',
      buildSql: buildDeleteExpiredActiveDraftsSql,
    },
  ];

  const deletedCounts = {};

  for (const step of cleanupSteps) {
    const threshold = draftThresholds[step.key];
    const statement = step.buildSql(threshold.unit);
    const [deleteResult] = await conn.execute(statement, [threshold.interval]);
    deletedCounts[step.key] = getMutationCount(deleteResult);
    console.log(`📝 已清理 ${step.key} 草稿: ${deletedCounts[step.key]} 条`);
  }

  return deletedCounts;
};

const cleanLifecycleDraftsOnce = async () => {
  const conn = await connection.getConnection();
  const draftThresholds = DRAFT_CLEANUP_THRESHOLDS[CRON_MODE];

  try {
    await conn.beginTransaction();
    await cleanLifecycleDrafts(conn, draftThresholds);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    console.error('❌ 清理 draft lifecycle 失败:', error);
    throw error;
  } finally {
    conn.release();
  }
};

/**
 * 通用清理孤儿文件函数
 * @param {string} fileType - 文件类型 ('image' | 'video')
 * @param {string} method - 清理方式 ('cron' | 'manual')
 */
const cleanOrphanFiles = async (fileType, method = 'cron', options = {}) => {
  const config = FILE_TYPE_CONFIG[fileType];
  const { skipDraftCleanup = false } = options;
  if (!config) {
    throw new Error(`不支持的文件类型: ${fileType}`);
  }

  console.log(`\n🧹 ==================== 开始清理孤儿${config.name} ====================`);
  console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'));

  const conn = await connection.getConnection();

  // 获取当前模式的清理阈值
  const fileThreshold = FILE_CLEANUP_THRESHOLDS[CRON_MODE];
  console.log(`🔍 清理阈值: ${fileThreshold.interval}${unitTextMap[fileThreshold.unit] || fileThreshold.unit}前创建的文件`);

  try {
    await conn.beginTransaction();

    // 0. 默认先清 lifecycle draft；由外层调度统一执行时可跳过，避免重复写库
    if (!skipDraftCleanup) {
      const draftThresholds = DRAFT_CLEANUP_THRESHOLDS[CRON_MODE];
      await cleanLifecycleDrafts(conn, draftThresholds);
    }

    // 1. 查找孤儿文件（创建时间超过阈值且未关联到文章的文件）
    let orphanFiles;

    if (fileType === 'image') {
      // 图片孤儿：未关联文章 且 未被视频封面引用
      const statement = buildFindOrphanFilesSql('image', fileThreshold.unit);
      [orphanFiles] = await conn.execute(statement, [fileType, fileThreshold.interval]);
    } else if (fileType === 'video') {
      // 视频孤儿：未关联文章
      const statement = buildFindOrphanFilesSql('video', fileThreshold.unit);
      [orphanFiles] = await conn.execute(statement, [fileType, fileThreshold.interval]);
    } else {
      throw new Error(`不支持的文件类型: ${fileType}`);
    }

    if (orphanFiles.length === 0) {
      console.log(`ℹ️ 没有需要清理的孤儿${config.name}`);
      await conn.commit();
      return;
    }

    const activeVideo = fileType === 'video' && orphanFiles.find((file) => ['pending', 'processing'].includes(file.transcode_status));
    if (activeVideo) {
      throw new Error(`拒绝清理仍在转码中的视频（ID: ${activeVideo.id}）`);
    }

    console.log(`📊 找到 ${orphanFiles.length} 个孤儿${config.name}需要清理:`);

    // 2. 打印详细信息
    const unitText = unitTextMap[fileThreshold.unit] || fileThreshold.unit;
    orphanFiles.forEach((file, index) => {
      console.log(`   ${index + 1}. ID: ${file.id}, 文件: ${file.filename}, 创建于: ${file.age_in_units} ${unitText}前`);
    });

    // 3. 图片、视频和 poster 都可能已经晋升到 R2；先幂等删除远端对象，
    //    pending promotion 或删除失败时保留记录与本地文件供安全重试
    const fileIds = orphanFiles.map((file) => file.id);
    await mediaRuntime.deleteR2ObjectsForFiles(fileIds);

    // 4. 先在同一事务写入本地清理 outbox，再删除数据库记录。
    const cleanupIds = await localMediaCleanup.enqueueInTransaction(conn, localMediaCleanup.buildLocalCleanupEntries(orphanFiles));

    // 5. 删除数据库记录（使用参数化查询防止 SQL 注入）
    const [deleteResult] = await conn.execute(`DELETE FROM file WHERE ${SqlUtils.queryIn('id', fileIds)}`, fileIds);

    // 5. 记录清理日志（可选，需要先创建 cleanup_log 表）
    // try {
    //   await conn.execute(
    //     `
    //     INSERT INTO cleanup_log (file_ids, file_count, file_type, method, create_time)
    //     VALUES (?, ?, ?, ?, NOW())
    //     `,
    //     [JSON.stringify(fileIds), fileIds.length, fileType, method]
    //   );
    // } catch (logError) {
    //   console.warn('⚠️ 记录清理日志失败（cleanup_log 表可能不存在）:', logError.message);
    // }

    await conn.commit();

    // 6. 数据库提交成功后消费精确文件名；失败记录留在 outbox 供重启/下次 cron 重试。
    const localCleanup = await localMediaCleanup.processPending({ ids: cleanupIds });

    console.log(`✅ 清理完成! 删除了 ${localCleanup.deleted + localCleanup.missing} 个本地文件，${deleteResult.affectedRows} 条数据库记录`);

    // 6. 统计信息
    const totalSize = orphanFiles.reduce((sum, file) => sum + file.size, 0);
    console.log(`💾 释放存储空间: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  } catch (error) {
    await conn.rollback();
    console.error(`❌ 清理孤儿${config.name}失败:`, error);
  } finally {
    conn.release();
    console.log('==================== 清理任务结束 ====================\n');
  }
};

/**
 * 清理孤儿图片（保留此函数以保持向后兼容）
 */
const cleanOrphanImages = async () => {
  return cleanOrphanFiles('image', 'cron');
};

/**
 * 清理孤儿视频（扩展示例）
 */
const cleanOrphanVideos = async () => {
  return cleanOrphanFiles('video', 'cron');
};

/**
 * 创建定时任务
 * 默认：每天凌晨 2 点执行
 * Cron 表达式：秒 分 时 日 月 周
 */
const cronExpression = CRON_EXPRESSIONS[CRON_MODE];
const task = cron.schedule(
  cronExpression,
  async () => {
    await localMediaCleanup.processPending();
    // 整次任务只清一次 draft lifecycle，再依次清理各类孤儿文件
    await cleanLifecycleDraftsOnce();
    await cleanOrphanFiles('image', 'cron', { skipDraftCleanup: true });
    await cleanOrphanFiles('video', 'cron', { skipDraftCleanup: true });
  },
  {
    scheduled: false, // 默认不启动，需要手动调用 task.start()
    timezone: 'Asia/Shanghai', // 时区
  },
);

/**
 * 手动触发清理（用于测试）
 */
const runNow = async () => {
  console.log('🚀 手动触发清理任务...');
  await cleanOrphanImages();
  // 未来添加视频清理时取消注释：
  // await cleanOrphanVideos();
};

module.exports = {
  task,
  start: () => {
    const modeText = CRON_MODE === 'test' ? '测试模式：自定义时间执行' : '生产模式：每天凌晨 2 点执行';
    console.log(`⏰ 孤儿文件清理任务已启动（${modeText}）`);
    console.log(`📅 Cron 表达式: ${cronExpression}`);
    localMediaCleanup.processPending().catch((error) => {
      console.error('❌ 启动时重试本地媒体清理失败:', error.message);
    });
    task.start();
  },
  stop: () => {
    console.log('⏸️ 孤儿文件清理任务已停止');
    task.stop();
  },
  runNow, // 导出手动触发函数
  cleanOrphanImages, // 导出图片清理函数
  cleanOrphanVideos, // 导出视频清理函数
  cleanOrphanFiles, // 导出通用清理函数
};

// 如果直接运行此文件，立即执行清理（用于测试）
if (require.main === module) {
  console.log('🧪 测试模式：立即执行清理任务\n');
  (async () => {
    await cleanOrphanImages();
    // 未来添加视频清理时取消注释：
    // await cleanOrphanVideos();
    process.exit(0);
  })();
}
