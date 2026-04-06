#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const {
  buildAddCollectSql,
  buildGetCollectArticleSql,
  buildGetCollectListExecuteParams,
  buildGetCollectListSql,
} = require('../../src/service/collect.sql');
const { evaluateFlowParity } = require('./verify-article-read-parity');
const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');

const PG_COLLECT_ALIAS_TO_CAMEL = {
  createat: 'createAt',
  updateat: 'updateAt',
  userid: 'userId',
  collectedarticle: 'collectedArticle',
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
};

const remapPgCollectRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_COLLECT_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
      return [mapped, value];
    })
  );
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

const insertMySql = async (mysqlPool, sql, params) => {
  const result = await executeMySql(mysqlPool, sql, params);
  return Number(result?.insertId);
};

const insertPg = async (pgPool, sql, params) => {
  const rows = await executePg(pgPool, sql, params);
  return Number(rows[0]?.id);
};

const fetchSampleCollectAnchor = async (mysqlPool) => {
  const rows = await executeMySql(
    mysqlPool,
    `SELECT
       c.user_id AS userId,
       c.id AS collectId
     FROM collect c
     INNER JOIN user u ON u.id = c.user_id
     LEFT JOIN article_collect ac ON ac.collect_id = c.id
     GROUP BY c.id
     HAVING COUNT(ac.article_id) > 0
     ORDER BY c.id
     LIMIT 1;`
  );
  if (rows[0]) return rows[0];

  const fallback = await executeMySql(
    mysqlPool,
    `SELECT c.user_id AS userId, c.id AS collectId
     FROM collect c
     INNER JOIN user u ON u.id = c.user_id
     ORDER BY c.id
     LIMIT 1;`
  );
  return fallback[0] || null;
};

const buildCollectParityReport = async (mysqlPool, pgPool, options = {}) => {
  let userId = options.userId;
  let collectId = options.collectId;

  if (userId == null || collectId == null) {
    const sample = await fetchSampleCollectAnchor(mysqlPool);
    if (!sample) {
      throw new Error(
        'No sample (userId, collectId) from collect; pass --user-id and --collect-id explicitly.'
      );
    }
    userId = userId ?? sample.userId;
    collectId = collectId ?? sample.collectId;
  }

  const listOffset = Number(options.listOffset ?? 0);
  const listLimit = Number(options.listLimit ?? 10);
  const previewLimit = options.previewLimit;

  const flows = [];
  const mysqlInsertedIds = [];
  const pgInsertedIds = [];

  try {
    // Flow 1: getCollectList read parity
    const mysqlListSql = buildGetCollectListSql('mysql');
    const pgListSql = buildGetCollectListSql('pg');
    const mysqlListParams = buildGetCollectListExecuteParams('mysql', userId, String(listOffset), String(listLimit));
    const pgListParams = buildGetCollectListExecuteParams('pg', userId, String(listOffset), String(listLimit));

    const mysqlListRows = await executeMySql(mysqlPool, mysqlListSql, mysqlListParams);
    const pgListRowsRaw = await executePg(pgPool, pgListSql, pgListParams);
    const pgListRows = pgListRowsRaw.map((row) => remapPgCollectRow(row));

    flows.push(evaluateFlowParity(
      'getCollectList',
      { userId, offset: listOffset, limit: listLimit },
      mysqlListRows,
      pgListRows,
      { previewLimit }
    ));

    // Flow 2: getCollectArticle read parity
    const mysqlArticleSql = buildGetCollectArticleSql('mysql');
    const pgArticleSql = buildGetCollectArticleSql('pg');

    const mysqlArticleRows = await executeMySql(mysqlPool, mysqlArticleSql, [collectId]);
    const pgArticleRowsRaw = await executePg(pgPool, pgArticleSql, [collectId]);
    const pgArticleRows = pgArticleRowsRaw.map((row) => remapPgCollectRow(row));

    flows.push(evaluateFlowParity(
      'getCollectArticle',
      { collectId },
      mysqlArticleRows,
      pgArticleRows,
      { previewLimit }
    ));

    // Flow 3: addCollect write parity
    const testName = `p_${Date.now() % 1e9}`;
    const myCollectId = await insertMySql(mysqlPool, buildAddCollectSql('mysql'), [userId, testName]);
    mysqlInsertedIds.push(myCollectId);
    const pgCollectId = await insertPg(pgPool, buildAddCollectSql('pg'), [userId, testName]);
    pgInsertedIds.push(pgCollectId);

    const myReadBack = await executeMySql(mysqlPool, 'SELECT * FROM collect WHERE id = ?', [myCollectId]);
    const pgReadBackRaw = await executePg(pgPool, 'SELECT * FROM collect WHERE id = ?', [pgCollectId]);
    const pgReadBack = pgReadBackRaw.map((row) => remapPgCollectRow(row));

    const mysqlPersisted = myReadBack.length > 0;
    const pgPersisted = pgReadBack.length > 0;
    const bothPersisted = mysqlPersisted && pgPersisted;

    let structureMatch = false;
    if (bothPersisted) {
      const myNorm = normalizeCollectForCompare(myReadBack[0]);
      const pgNorm = normalizeCollectForCompare(pgReadBack[0]);
      structureMatch = stableStringify(myNorm) === stableStringify(pgNorm);
    }

    flows.push({
      flow: 'addCollect',
      input: { userId, name: testName },
      isMatched: bothPersisted && structureMatch,
      stopConditions: {
        countMismatch: false,
        orderMismatch: false,
        missingPersistedRow: !bothPersisted,
        structureMismatch: bothPersisted && !structureMatch,
      },
      mysqlPersisted,
      pgPersisted,
    });
  } finally {
    for (const id of mysqlInsertedIds) {
      await executeMySql(mysqlPool, 'DELETE FROM collect WHERE id = ?', [id]).catch(() => {});
    }
    for (const id of pgInsertedIds) {
      await executePg(pgPool, 'DELETE FROM collect WHERE id = ?', [id]).catch(() => {});
    }
  }

  const stopConditions = {
    countMismatch: flows.some((f) => f.stopConditions.countMismatch),
    orderMismatch: flows.some((f) => f.stopConditions.orderMismatch),
    structureMismatch: flows.some((f) => f.stopConditions.structureMismatch),
    missingPersistedRow: flows.some((f) => f.stopConditions?.missingPersistedRow),
  };

  return {
    isSuccess: flows.every((f) => f.isMatched),
    userId,
    collectId,
    listOffset,
    listLimit,
    stopConditions,
    flows,
    cleanup: { mysqlDeleted: mysqlInsertedIds.length, pgDeleted: pgInsertedIds.length },
  };
};

const COLLECT_NUMERIC_FIELDS = ['id', 'user_id', 'userId'];

const coerceNumericFields = (row) => {
  if (!row || typeof row !== 'object') return;
  COLLECT_NUMERIC_FIELDS.forEach((field) => {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      row[field] = Number(row[field]);
    }
  });
};

const normalizeCollectForCompare = (row) => {
  if (!row || typeof row !== 'object') return row;
  const clone = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || key === 'createAt' || key === 'updateAt' || key === 'create_at' || key === 'update_at') continue;
    if (value instanceof Date) {
      clone[key] = value.toISOString();
    } else {
      clone[key] = value;
    }
  }
  coerceNumericFields(clone);
  return clone;
};

const stableStringify = (obj) => {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj.map((item) => JSON.parse(stableStringify(item))));
  const ordered = Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = JSON.parse(stableStringify(obj[key]));
    return acc;
  }, {});
  return JSON.stringify(ordered);
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatCollectParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((f) => !f.isMatched);

  lines.push(`Collect parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`User/collect: ${report.userId} / ${report.collectId}`);
  lines.push(`Cleanup: mysql=${report.cleanup.mysqlDeleted} pg=${report.cleanup.pgDeleted}`);

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
    const userId = parseOptionalId(runtime.args['user-id']);
    const collectId = parseOptionalId(runtime.args['collect-id']);

    const report = await buildCollectParityReport(mysqlPool, pgPool, {
      userId: userId ?? undefined,
      collectId: collectId ?? undefined,
      listOffset: parseOptionalId(runtime.args['list-offset']) ?? 0,
      listLimit: parseOptionalId(runtime.args['list-limit']) ?? runtime.sampleLimit,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatCollectParitySummary(report));

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
    console.error('Collect parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCollectParityReport,
  formatCollectParitySummary,
  remapPgCollectRow,
};
