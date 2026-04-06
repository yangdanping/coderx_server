#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const { buildFindOrphanFilesSql } = require('../../src/tasks/cleanOrphanFiles.sql');
const { evaluateFlowParity } = require('./verify-article-read-parity');
const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');

const PG_ORPHAN_ALIAS_TO_CAMEL = {
  createtime: 'createTime',
  age_in_units: 'age_in_units',
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
};

const remapPgOrphanRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_ORPHAN_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
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

const buildCleanOrphanParityReport = async (mysqlPool, pgPool, options = {}) => {
  const thresholdValue = Number(options.thresholdValue ?? 0);
  const thresholdUnit = options.thresholdUnit || 'SECOND';
  const previewLimit = options.previewLimit;

  const flows = [];

  // Flow 1: findOrphanFiles for images
  const mysqlImageSql = buildFindOrphanFilesSql('mysql', 'image', thresholdUnit);
  const pgImageSql = buildFindOrphanFilesSql('pg', 'image', thresholdUnit);
  const mysqlImageRows = await executeMySql(mysqlPool, mysqlImageSql, ['image', thresholdValue]);
  const pgImageRows = (await executePg(pgPool, pgImageSql, ['image', thresholdValue])).map(remapPgOrphanRow);
  flows.push(evaluateFlowParity(
    'findOrphanFiles:image',
    { fileType: 'image', thresholdValue, thresholdUnit },
    mysqlImageRows,
    pgImageRows,
    { previewLimit }
  ));

  // Flow 2: findOrphanFiles for videos
  const mysqlVideoSql = buildFindOrphanFilesSql('mysql', 'video', thresholdUnit);
  const pgVideoSql = buildFindOrphanFilesSql('pg', 'video', thresholdUnit);
  const mysqlVideoRows = await executeMySql(mysqlPool, mysqlVideoSql, ['video', thresholdValue]);
  const pgVideoRows = (await executePg(pgPool, pgVideoSql, ['video', thresholdValue])).map(remapPgOrphanRow);
  flows.push(evaluateFlowParity(
    'findOrphanFiles:video',
    { fileType: 'video', thresholdValue, thresholdUnit },
    mysqlVideoRows,
    pgVideoRows,
    { previewLimit }
  ));

  const stopConditions = {
    countMismatch: flows.some((f) => f.stopConditions.countMismatch),
    orderMismatch: flows.some((f) => f.stopConditions.orderMismatch),
    structureMismatch: flows.some((f) => f.stopConditions.structureMismatch),
  };

  return {
    isSuccess: flows.every((f) => f.isMatched),
    thresholdValue,
    thresholdUnit,
    stopConditions,
    flows,
  };
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatCleanOrphanParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((f) => !f.isMatched);

  lines.push(`Clean-orphan parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`Threshold: ${report.thresholdValue} ${report.thresholdUnit}`);

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
    const report = await buildCleanOrphanParityReport(mysqlPool, pgPool, {
      thresholdValue: parseOptionalId(runtime.args['threshold-value']) ?? 0,
      thresholdUnit: runtime.args['threshold-unit'] || 'SECOND',
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatCleanOrphanParitySummary(report));

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
    console.error('Clean-orphan parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCleanOrphanParityReport,
  formatCleanOrphanParitySummary,
  remapPgOrphanRow,
};
