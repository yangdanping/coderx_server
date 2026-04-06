#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const { evaluateFlowParity } = require('./verify-article-read-parity');
const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');

const PG_FILE_ALIAS_TO_CAMEL = {
  createat: 'createAt',
  updateat: 'updateAt',
  create_at: 'create_at',
  update_at: 'update_at',
  is_cover: 'is_cover',
  file_type: 'file_type',
  article_id: 'article_id',
  user_id: 'user_id',
  transcode_status: 'transcode_status',
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
};

const remapPgFileRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_FILE_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
      return [mapped, value];
    })
  );
};

const BOOLEAN_FIELDS = ['is_cover'];

const normalizeBooleanFields = (row) => {
  if (!row || typeof row !== 'object') return row;
  const clone = { ...row };
  for (const field of BOOLEAN_FIELDS) {
    if (clone[field] !== undefined && clone[field] !== null) {
      clone[field] = Boolean(clone[field]);
    }
  }
  return clone;
};

const executeMySql = async (mysqlPool, sql, params = []) => {
  const runner = typeof mysqlPool.execute === 'function' ? mysqlPool.execute.bind(mysqlPool) : mysqlPool.query.bind(mysqlPool);
  const [rows] = await runner(sql, params);
  return rows;
};

const executePg = async (pgPool, sql, params = []) => {
  const result = await pgPool.query(convertQuestionPlaceholders(sql), params);
  return result.rows;
};

const ARTICLE_IMAGES_SQL = `
  SELECT f.id, f.filename, f.mimetype, f.size, im.is_cover, im.width, im.height
  FROM file f
  LEFT JOIN image_meta im ON f.id = im.file_id
  WHERE f.article_id = ? AND f.file_type = 'image'
  ORDER BY im.is_cover DESC, f.create_at ASC;
`;

const ARTICLE_VIDEOS_SQL = `
  SELECT f.id, f.filename, f.mimetype, f.size,
         vm.poster, vm.duration, vm.width, vm.height, vm.bitrate, vm.format, vm.transcode_status
  FROM file f
  LEFT JOIN video_meta vm ON f.id = vm.file_id
  WHERE f.article_id = ? AND f.file_type = 'video'
  ORDER BY f.create_at ASC;
`;

const fetchSampleArticleWithFiles = async (mysqlPool) => {
  const rows = await executeMySql(
    mysqlPool,
    `SELECT DISTINCT f.article_id AS articleId
     FROM file f
     WHERE f.article_id IS NOT NULL
     ORDER BY f.article_id
     LIMIT 1;`
  );
  return rows[0]?.articleId ?? null;
};

const buildFileMetaParityReport = async (mysqlPool, pgPool, options = {}) => {
  let articleId = options.articleId;

  if (articleId == null) {
    articleId = await fetchSampleArticleWithFiles(mysqlPool);
    if (articleId == null) {
      throw new Error('No article with files found; pass --article-id explicitly.');
    }
  }

  const previewLimit = options.previewLimit;
  const flows = [];

  // Flow 1: getArticleImages
  const mysqlImageRows = (await executeMySql(mysqlPool, ARTICLE_IMAGES_SQL, [articleId])).map(normalizeBooleanFields);
  const pgImageRows = (await executePg(pgPool, ARTICLE_IMAGES_SQL, [articleId])).map(remapPgFileRow).map(normalizeBooleanFields);
  flows.push(evaluateFlowParity('getArticleImages', { articleId }, mysqlImageRows, pgImageRows, { previewLimit }));

  // Flow 2: getArticleVideos
  const mysqlVideoRows = await executeMySql(mysqlPool, ARTICLE_VIDEOS_SQL, [articleId]);
  const pgVideoRows = (await executePg(pgPool, ARTICLE_VIDEOS_SQL, [articleId])).map(remapPgFileRow);
  flows.push(evaluateFlowParity('getArticleVideos', { articleId }, mysqlVideoRows, pgVideoRows, { previewLimit }));

  const stopConditions = {
    countMismatch: flows.some((f) => f.stopConditions.countMismatch),
    orderMismatch: flows.some((f) => f.stopConditions.orderMismatch),
    structureMismatch: flows.some((f) => f.stopConditions.structureMismatch),
  };

  return {
    isSuccess: flows.every((f) => f.isMatched),
    articleId,
    stopConditions,
    flows,
  };
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatFileMetaParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((f) => !f.isMatched);

  lines.push(`File/meta parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`Article: ${report.articleId}`);

  if (failingFlows.length === 0) {
    lines.push('Stop conditions: clean');
    return lines.join('\n');
  }

  lines.push('Failing flows:');
  failingFlows.forEach((f) => {
    lines.push(`- ${f.flow}: ${formatStopConditions(f.stopConditions)} input=${JSON.stringify(f.input)}`);
  });

  return lines.join('\n');
};

const writeReportFile = (report, reportFilePath) => {
  const resolvedPath = resolveAbsolutePath(reportFilePath);
  if (!resolvedPath) return null;
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
};

const parseOptionalId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const main = async () => {
  const runtime = buildRuntimeConfig(process.argv.slice(2));
  const mysqlPool = createMySqlPool(runtime.mysqlConfig);
  const pgPool = createPgPool(runtime.pgConfig);

  try {
    const articleId = parseOptionalId(runtime.args['article-id']);

    const report = await buildFileMetaParityReport(mysqlPool, pgPool, {
      articleId: articleId ?? undefined,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatFileMetaParitySummary(report));

    if (reportPath) {
      console.log(`Report file: ${reportPath}`);
    }

    if (!report.isSuccess) {
      process.exitCode = 1;
    }
  } finally {
    await closePools(mysqlPool, pgPool);
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('File/meta parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildFileMetaParityReport,
  formatFileMetaParitySummary,
  remapPgFileRow,
};
