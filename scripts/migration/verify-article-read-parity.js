#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');
const { normalizeComparableRow } = require('./phase2/lib/migrationUtils');
const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const {
  buildArticleListExecuteParams,
  buildArticleListQueryParams,
  buildGetArticleByIdSql,
  buildGetArticleListSql,
  buildGetArticlesByKeyWordsExecuteParams,
  buildGetArticlesByKeyWordsSql,
  buildGetRecommendArticleListExecuteParams,
  buildGetRecommendArticleListSql,
} = require('../../src/service/article.sql');

const DEFAULT_PREVIEW_LIMIT = 3;

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) {
    return null;
  }

  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(process.cwd(), inputPath);
};

const parseCommaSeparatedList = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => parseCommaSeparatedList(item));
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const tryParseJsonString = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const looksLikeJson =
    trimmed === 'null' ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (!looksLikeJson) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const normalizeDateLikeString = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const looksLikeDateTime = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)?(?:Z)?$/.test(trimmed);
  if (!looksLikeDateTime) {
    return value;
  }

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const candidate = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const timestamp = Date.parse(candidate);

  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp);
};

const normalizePayload = (value) => {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizePayload(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, normalizePayload(nestedValue)]));
  }

  if (typeof value === 'string') {
    const parsed = tryParseJsonString(value);
    if (parsed !== value) {
      return normalizePayload(parsed);
    }

    const normalizedDate = normalizeDateLikeString(value);
    if (normalizedDate !== value) {
      return normalizedDate;
    }
  }

  return value;
};

const normalizeParityRow = (row) => {
  return normalizeComparableRow(normalizePayload(row));
};

const serializeComparableRow = (row) => {
  const orderedEntries = Object.keys(row)
    .sort()
    .map((key) => [key, row[key]]);
  return JSON.stringify(Object.fromEntries(orderedEntries));
};

const arraysEqual = (left, right) => {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
};

const evaluateFlowParity = (flow, input, mysqlRows, pgRows, options = {}) => {
  const previewLimit = Number(options.previewLimit || DEFAULT_PREVIEW_LIMIT);
  const normalizedMysqlRows = mysqlRows.map((row) => normalizeParityRow(row));
  const normalizedPgRows = pgRows.map((row) => normalizeParityRow(row));
  const mysqlSignatures = normalizedMysqlRows.map((row) => serializeComparableRow(row));
  const pgSignatures = normalizedPgRows.map((row) => serializeComparableRow(row));
  const countMismatch = mysqlSignatures.length !== pgSignatures.length;
  const signaturesMatchInOrder = arraysEqual(mysqlSignatures, pgSignatures);
  const sameRowsDifferentOrder =
    !countMismatch &&
    !signaturesMatchInOrder &&
    arraysEqual(
      [...mysqlSignatures].sort(),
      [...pgSignatures].sort()
    );

  const stopConditions = {
    countMismatch,
    orderMismatch: sameRowsDifferentOrder,
    structureMismatch: !countMismatch && !signaturesMatchInOrder && !sameRowsDifferentOrder,
  };

  return {
    flow,
    input,
    mysqlRowCount: normalizedMysqlRows.length,
    pgRowCount: normalizedPgRows.length,
    isMatched: !stopConditions.countMismatch && !stopConditions.orderMismatch && !stopConditions.structureMismatch,
    stopConditions,
    mysqlPreview: normalizedMysqlRows.slice(0, previewLimit),
    pgPreview: normalizedPgRows.slice(0, previewLimit),
  };
};

const executeMySql = async (mysqlPool, sql, params = []) => {
  const [rows] = await mysqlPool.query(sql, params);
  return rows;
};

const executePg = async (pgPool, sql, params = []) => {
  const result = await pgPool.query(convertQuestionPlaceholders(sql), params);
  return result.rows;
};

const fetchSampleArticleRows = async (mysqlPool, sampleLimit) => {
  const [rows] = await mysqlPool.query('SELECT id, title FROM article ORDER BY id LIMIT ?;', [sampleLimit]);
  return rows;
};

const deriveSearchKeywords = (articleRows, maxCount = 1) => {
  const keywords = [];
  const seen = new Set();

  for (const row of articleRows) {
    const title = String(row?.title || '').trim();
    if (!title) {
      continue;
    }

    const keyword = title.slice(0, Math.min(6, title.length));
    if (!keyword || seen.has(keyword)) {
      continue;
    }

    keywords.push(keyword);
    seen.add(keyword);

    if (keywords.length >= maxCount) {
      break;
    }
  }

  return keywords;
};

const buildDefaultListCases = (sampleLimit) => {
  return [
    { name: 'date', offset: 0, limit: sampleLimit, pageOrder: 'date' },
    { name: 'hot', offset: 0, limit: sampleLimit, pageOrder: 'hot' },
  ];
};

const buildDefaultRecommendCases = (sampleLimit) => {
  return [{ name: 'default', offset: 0, limit: sampleLimit }];
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

const buildArticleReadParityReport = async (mysqlPool, pgPool, options = {}) => {
  const sampleLimit = Number(options.sampleLimit || 5);
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

  const sampleArticleRows =
    options.detailIds && options.detailIds.length > 0 ? [] : await fetchSampleArticleRows(mysqlPool, sampleLimit);

  const detailIds = (options.detailIds && options.detailIds.length > 0 ? options.detailIds : sampleArticleRows.map((row) => row.id)).map((id) =>
    String(id)
  );
  const listCases = options.listCases && options.listCases.length > 0 ? options.listCases : buildDefaultListCases(sampleLimit);
  const recommendCases =
    options.recommendCases && options.recommendCases.length > 0 ? options.recommendCases : buildDefaultRecommendCases(sampleLimit);
  const derivedSearchRows = [...sampleArticleRows];
  let searchKeywords = options.searchKeywords && options.searchKeywords.length > 0 ? options.searchKeywords : [];

  const flows = [];

  for (const articleId of detailIds) {
    const mysqlRows = await executeMySql(mysqlPool, buildGetArticleByIdSql('mysql', baseURL, redirectURL), [articleId]);
    const pgRows = await executePg(pgPool, buildGetArticleByIdSql('pg', baseURL, redirectURL), [articleId]);
    derivedSearchRows.push(...mysqlRows);
    flows.push(evaluateFlowParity('getDetail', { articleId }, mysqlRows, pgRows, options));
  }

  if (searchKeywords.length === 0) {
    searchKeywords = deriveSearchKeywords(derivedSearchRows, 1);
  }

  for (const listCase of listCases) {
    const tagId = listCase.tagId || '';
    const userId = listCase.userId || '';
    const idList = Array.isArray(listCase.idList) ? listCase.idList : [];
    const keywords = listCase.keywords || '';
    const pageOrder = listCase.pageOrder || 'date';
    const queryParams = buildArticleListQueryParams(tagId, userId, idList, keywords);
    const mysqlSql = buildGetArticleListSql('mysql', baseURL, redirectURL, {
      tagId,
      userId,
      idList,
      keywords,
      pageOrder,
    });
    const pgSql = buildGetArticleListSql('pg', baseURL, redirectURL, {
      tagId,
      userId,
      idList,
      keywords,
      pageOrder,
    });

    const mysqlRows = await executeMySql(
      mysqlPool,
      mysqlSql,
      buildArticleListExecuteParams('mysql', queryParams, listCase.offset, listCase.limit)
    );
    const pgRows = await executePg(
      pgPool,
      pgSql,
      buildArticleListExecuteParams('pg', queryParams, listCase.offset, listCase.limit)
    );

    flows.push(
      evaluateFlowParity(
        `getList:${listCase.name || pageOrder}`,
        {
          offset: listCase.offset,
          limit: listCase.limit,
          pageOrder,
          tagId,
          userId,
          idList,
          keywords,
        },
        mysqlRows,
        pgRows,
        options
      )
    );
  }

  for (const recommendCase of recommendCases) {
    const mysqlRows = await executeMySql(
      mysqlPool,
      buildGetRecommendArticleListSql('mysql', redirectURL),
      buildGetRecommendArticleListExecuteParams('mysql', recommendCase.offset, recommendCase.limit)
    );
    const pgRows = await executePg(
      pgPool,
      buildGetRecommendArticleListSql('pg', redirectURL),
      buildGetRecommendArticleListExecuteParams('pg', recommendCase.offset, recommendCase.limit)
    );

    flows.push(
      evaluateFlowParity(
        `getRecommendList:${recommendCase.name || 'default'}`,
        {
          offset: recommendCase.offset,
          limit: recommendCase.limit,
        },
        mysqlRows,
        pgRows,
        options
      )
    );
  }

  for (const keyword of searchKeywords) {
    const mysqlRows = await executeMySql(
      mysqlPool,
      buildGetArticlesByKeyWordsSql('mysql', redirectURL),
      buildGetArticlesByKeyWordsExecuteParams('mysql', keyword)
    );
    const pgRows = await executePg(
      pgPool,
      buildGetArticlesByKeyWordsSql('pg', redirectURL),
      buildGetArticlesByKeyWordsExecuteParams('pg', keyword)
    );

    flows.push(evaluateFlowParity(`search:${keyword}`, { keyword }, mysqlRows, pgRows, options));
  }

  const stopConditions = {
    countMismatch: flows.some((flow) => flow.stopConditions.countMismatch),
    orderMismatch: flows.some((flow) => flow.stopConditions.orderMismatch),
    structureMismatch: flows.some((flow) => flow.stopConditions.structureMismatch),
  };

  return {
    isSuccess: !stopConditions.countMismatch && !stopConditions.orderMismatch && !stopConditions.structureMismatch,
    sampleArticleIds: detailIds,
    derivedSearchKeywords: searchKeywords,
    stopConditions,
    flows,
  };
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatArticleReadParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((flow) => !flow.isMatched);

  lines.push(`Article read parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`Sample detail IDs: ${report.sampleArticleIds?.length ? report.sampleArticleIds.join(', ') : 'none'}`);
  lines.push(`Search keywords: ${report.derivedSearchKeywords?.length ? report.derivedSearchKeywords.join(', ') : 'none'}`);

  if (failingFlows.length === 0) {
    lines.push('Stop conditions: clean');
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

const main = async () => {
  const runtime = buildRuntimeConfig(process.argv.slice(2));
  const mysqlPool = createMySqlPool(runtime.mysqlConfig);
  const pgPool = createPgPool(runtime.pgConfig);

  try {
    const detailIds = parseCommaSeparatedList(runtime.args['detail-ids']);
    const searchKeywords = parseCommaSeparatedList(runtime.args['search-keywords']);
    const report = await buildArticleReadParityReport(mysqlPool, pgPool, {
      sampleLimit: runtime.sampleLimit,
      baseURL: runtime.args['base-url'],
      redirectURL: runtime.args['redirect-url'],
      detailIds,
      searchKeywords,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatArticleReadParitySummary(report));

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
    console.error('Article read parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildArticleReadParityReport,
  deriveSearchKeywords,
  evaluateFlowParity,
  formatArticleReadParitySummary,
};
