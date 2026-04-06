#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');
const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const {
  buildAddHistorySql,
  buildGetUserHistorySql,
  buildUserHistoryExecuteParams,
} = require('../../src/service/history.sql');
const { evaluateFlowParity } = require('./verify-article-read-parity');

const COUNT_PAIR_SQL_MYSQL = 'SELECT COUNT(*) AS cnt FROM article_history WHERE user_id = ? AND article_id = ?';
const COUNT_PAIR_SQL_PG = 'SELECT COUNT(*)::int AS cnt FROM article_history WHERE user_id = ? AND article_id = ?';

/** PostgreSQL folds unquoted SELECT aliases to lowercase; align keys with mysql2 for parity compare. */
const PG_HISTORY_ALIAS_TO_CAMEL = {
  createat: 'createAt',
  updateat: 'updateAt',
  articleid: 'articleId',
  articlecreateat: 'articleCreateAt',
  commentcount: 'commentCount',
  articleurl: 'articleUrl',
};

const remapPgHistoryRowKeys = (row) => {
  if (!row || typeof row !== 'object') {
    return row;
  }

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_HISTORY_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
      return [mapped, value];
    })
  );
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) {
    return null;
  }

  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(process.cwd(), inputPath);
};

const resolveUrlOption = (directValue, fallbackValue, label) => {
  if (directValue) {
    return directValue;
  }

  if (fallbackValue) {
    return fallbackValue;
  }

  throw new Error(`Missing required URL option: ${label}. Provide it explicitly or load APP_* env vars.`);
};

const executeMySql = async (mysqlPool, sql, params = []) => {
  const [rows] = await mysqlPool.query(sql, params);
  return rows;
};

const executePg = async (pgPool, sql, params = []) => {
  const result = await pgPool.query(convertQuestionPlaceholders(sql), params);
  return result.rows;
};

const countPairRows = async (pool, dialect, userId, articleId) => {
  if (dialect === 'pg') {
    const rows = await executePg(pool, COUNT_PAIR_SQL_PG, [userId, articleId]);
    return Number(rows[0]?.cnt ?? 0);
  }

  const rows = await executeMySql(pool, COUNT_PAIR_SQL_MYSQL, [userId, articleId]);
  return Number(rows[0]?.cnt ?? 0);
};

const runAddHistory = async (pool, dialect, userId, articleId) => {
  const sql = buildAddHistorySql(dialect === 'pg' ? 'pg' : 'mysql');
  if (dialect === 'pg') {
    await executePg(pool, sql, [userId, articleId]);
  } else {
    await executeMySql(pool, sql, [userId, articleId]);
  }
};

const fetchSampleHistoryPair = async (mysqlPool) => {
  const [rows] = await mysqlPool.query(
    `SELECT ah.user_id AS userId, ah.article_id AS articleId
     FROM article_history ah
     INNER JOIN article a ON a.id = ah.article_id
     WHERE ah.user_id IS NOT NULL AND ah.article_id IS NOT NULL
     ORDER BY ah.id
     LIMIT 1;`
  );
  return rows[0] || null;
};

const buildUpsertEvidence = async (mysqlPool, pgPool, userId, articleId) => {
  const mysqlCountBefore = await countPairRows(mysqlPool, 'mysql', userId, articleId);
  await runAddHistory(mysqlPool, 'mysql', userId, articleId);
  const mysqlCountAfterFirst = await countPairRows(mysqlPool, 'mysql', userId, articleId);
  await runAddHistory(mysqlPool, 'mysql', userId, articleId);
  const mysqlCountAfterSecond = await countPairRows(mysqlPool, 'mysql', userId, articleId);

  const pgCountBefore = await countPairRows(pgPool, 'pg', userId, articleId);
  await runAddHistory(pgPool, 'pg', userId, articleId);
  const pgCountAfterFirst = await countPairRows(pgPool, 'pg', userId, articleId);
  await runAddHistory(pgPool, 'pg', userId, articleId);
  const pgCountAfterSecond = await countPairRows(pgPool, 'pg', userId, articleId);

  const mysqlIdempotent = mysqlCountAfterFirst === mysqlCountAfterSecond;
  const pgIdempotent = pgCountAfterFirst === pgCountAfterSecond;
  const countsMatch = mysqlCountAfterSecond === pgCountAfterSecond;
  const duplicatePairRows = {
    mysql: mysqlCountAfterSecond > 1,
    pg: pgCountAfterSecond > 1,
  };

  const pairRowPersisted = {
    mysql: mysqlCountAfterSecond >= 1,
    pg: pgCountAfterSecond >= 1,
  };
  const bothEnginesPersistRow = pairRowPersisted.mysql && pairRowPersisted.pg;

  return {
    mysql: {
      countBefore: mysqlCountBefore,
      countAfterFirst: mysqlCountAfterFirst,
      countAfterSecond: mysqlCountAfterSecond,
      idempotent: mysqlIdempotent,
    },
    pg: {
      countBefore: pgCountBefore,
      countAfterFirst: pgCountAfterFirst,
      countAfterSecond: pgCountAfterSecond,
      idempotent: pgIdempotent,
    },
    countsMatch,
    duplicatePairRows,
    pairRowPersisted,
    bothEnginesPersistRow,
  };
};

const buildHistoryParityReport = async (mysqlPool, pgPool, options = {}) => {
  const baseURL = resolveUrlOption(
    options.baseURL,
    process.env.APP_HOST && process.env.APP_PORT ? `${process.env.APP_HOST}:${process.env.APP_PORT}` : null,
    'baseURL / --base-url'
  );
  const redirectURL = resolveUrlOption(
    options.redirectURL,
    process.env.APP_HOST && process.env.ASSETS_PORT ? `${process.env.APP_HOST}:${process.env.ASSETS_PORT}` : null,
    'redirectURL / --redirect-url'
  );

  let userId = options.userId;
  let articleId = options.articleId;

  if (userId == null || articleId == null) {
    const sample = await fetchSampleHistoryPair(mysqlPool);
    if (!sample) {
      throw new Error(
        'No sample (userId, articleId) from article_history; pass --user-id and --article-id explicitly.'
      );
    }
    userId = sample.userId;
    articleId = sample.articleId;
  }

  const historyOffset = Number(options.historyOffset ?? 0);
  const historyLimit = Number(options.historyLimit ?? 5);
  const previewLimit = options.previewLimit;

  const mysqlHistorySql = buildGetUserHistorySql('mysql', baseURL, redirectURL);
  const pgHistorySql = buildGetUserHistorySql('pg', baseURL, redirectURL);
  const mysqlHistoryRows = await executeMySql(
    mysqlPool,
    mysqlHistorySql,
    buildUserHistoryExecuteParams('mysql', userId, historyOffset, historyLimit)
  );
  const pgHistoryRowsRaw = await executePg(
    pgPool,
    pgHistorySql,
    buildUserHistoryExecuteParams('pg', userId, historyOffset, historyLimit)
  );
  const pgHistoryRows = pgHistoryRowsRaw.map((row) => remapPgHistoryRowKeys(row));

  const historyParity = evaluateFlowParity(
    'getUserHistory',
    { userId, offset: historyOffset, limit: historyLimit },
    mysqlHistoryRows,
    pgHistoryRows,
    { previewLimit }
  );

  const upsertEvidence = await buildUpsertEvidence(mysqlPool, pgPool, userId, articleId);

  const upsertMatched =
    upsertEvidence.bothEnginesPersistRow &&
    upsertEvidence.mysql.idempotent &&
    upsertEvidence.pg.idempotent &&
    upsertEvidence.countsMatch &&
    !upsertEvidence.duplicatePairRows.mysql &&
    !upsertEvidence.duplicatePairRows.pg;

  const upsertFlow = {
    flow: 'addHistory:doubleUpsert',
    input: { userId, articleId },
    isMatched: upsertMatched,
    stopConditions: {
      countMismatch: !upsertEvidence.countsMatch,
      orderMismatch: false,
      missingPersistedRow: !upsertEvidence.bothEnginesPersistRow,
      structureMismatch:
        !upsertEvidence.mysql.idempotent ||
        !upsertEvidence.pg.idempotent ||
        upsertEvidence.duplicatePairRows.mysql ||
        upsertEvidence.duplicatePairRows.pg,
    },
  };

  const flows = [historyParity, upsertFlow];

  const stopConditions = {
    countMismatch: flows.some((flow) => flow.stopConditions.countMismatch),
    orderMismatch: flows.some((flow) => flow.stopConditions.orderMismatch),
    structureMismatch: flows.some((flow) => flow.stopConditions.structureMismatch),
    missingPersistedRow: flows.some((flow) => flow.stopConditions.missingPersistedRow),
  };

  return {
    isSuccess: flows.every((flow) => flow.isMatched),
    userId,
    articleId,
    historyOffset,
    historyLimit,
    upsertEvidence,
    stopConditions,
    flows,
  };
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatHistoryParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((flow) => !flow.isMatched);

  lines.push(`History parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`User/article: ${report.userId} / ${report.articleId}`);
  lines.push(
    `Upsert counts (mysql): first=${report.upsertEvidence.mysql.countAfterFirst} second=${report.upsertEvidence.mysql.countAfterSecond} idempotent=${report.upsertEvidence.mysql.idempotent}`
  );
  lines.push(
    `Upsert counts (pg): first=${report.upsertEvidence.pg.countAfterFirst} second=${report.upsertEvidence.pg.countAfterSecond} idempotent=${report.upsertEvidence.pg.idempotent}`
  );
  lines.push(`Pair counts match: ${report.upsertEvidence.countsMatch}`);
  lines.push(
    `Duplicate pair rows: mysql=${report.upsertEvidence.duplicatePairRows.mysql} pg=${report.upsertEvidence.duplicatePairRows.pg}`
  );
  lines.push(
    `Persisted row (count>=1 after upserts): mysql=${report.upsertEvidence.pairRowPersisted.mysql} pg=${report.upsertEvidence.pairRowPersisted.pg} both=${report.upsertEvidence.bothEnginesPersistRow}`
  );

  if (failingFlows.length === 0 && report.isSuccess) {
    lines.push('Stop conditions: clean');
    return lines.join('\n');
  }

  if (failingFlows.length === 0) {
    lines.push('Failing flows: none listed (see upsert lines above)');
    return lines.join('\n');
  }

  lines.push('Failing flows:');
  failingFlows.forEach((flow) => {
    lines.push(`- ${flow.flow}: ${formatStopConditions(flow.stopConditions)} input=${JSON.stringify(flow.input)}`);
  });

  return lines.join('\n');
};

const writeReportFile = (report, reportFilePath) => {
  const resolvedPath = resolveAbsolutePath(reportFilePath);
  if (!resolvedPath) {
    return null;
  }

  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
};

const parseOptionalId = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return Number(value);
};

const main = async () => {
  const runtime = buildRuntimeConfig(process.argv.slice(2));
  const mysqlPool = createMySqlPool(runtime.mysqlConfig);
  const pgPool = createPgPool(runtime.pgConfig);

  try {
    const userId = parseOptionalId(runtime.args['user-id']);
    const articleId = parseOptionalId(runtime.args['article-id']);
    const historyOffset = parseOptionalId(runtime.args['history-offset']) ?? 0;
    const historyLimit = parseOptionalId(runtime.args['history-limit']) ?? runtime.sampleLimit;

    const report = await buildHistoryParityReport(mysqlPool, pgPool, {
      baseURL: runtime.args['base-url'],
      redirectURL: runtime.args['redirect-url'],
      userId: userId ?? undefined,
      articleId: articleId ?? undefined,
      historyOffset,
      historyLimit,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatHistoryParitySummary(report));

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
    console.error('History parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildHistoryParityReport,
  formatHistoryParitySummary,
  remapPgHistoryRowKeys,
};
