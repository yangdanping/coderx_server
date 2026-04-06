#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const { buildCheckStatusSql } = require('../../src/service/auth.sql');
const {
  buildFindUserByEmailSql,
  buildFindUserByGitHubIdSql,
  buildFindUserByGoogleIdSql,
} = require('../../src/service/oauth.sql');
const {
  buildGetFollowInfoSql,
  buildGetLikedByIdSql,
  buildGetProfileByIdSql,
  buildGetUserByNameSql,
} = require('../../src/service/user.sql');
const { evaluateFlowParity } = require('./verify-article-read-parity');
const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');

const PG_USER_ALIAS_TO_CAMEL = {
  avatarurl: 'avatarUrl',
  articlecount: 'articleCount',
  commentcount: 'commentCount',
  articleliked: 'articleLiked',
  commentliked: 'commentLiked',
  articleinfo: 'articleInfo',
  createat: 'createAt',
  updateat: 'updateAt',
  profileemail: 'profileEmail',
  oauth_provider: 'oauth_provider',
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
};

const remapPgUserRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_USER_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
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

const fetchSampleUser = async (mysqlPool) => {
  const rows = await executeMySql(
    mysqlPool,
    `SELECT u.id AS userId, u.name AS userName
     FROM user u
     INNER JOIN profile p ON u.id = p.user_id
     WHERE p.email IS NOT NULL
     ORDER BY u.id
     LIMIT 1;`
  );
  return rows[0] || null;
};

const buildUserAuthParityReport = async (mysqlPool, pgPool, options = {}) => {
  let userId = options.userId;
  let userName = options.userName;

  if (userId == null) {
    const sample = await fetchSampleUser(mysqlPool);
    if (!sample) {
      throw new Error('No sample user with profile; pass --user-id explicitly.');
    }
    userId = sample.userId;
    userName = userName ?? sample.userName;
  }

  const previewLimit = options.previewLimit;
  const flows = [];

  // Flow 1: checkStatus (auth)
  const mysqlStatusSql = buildCheckStatusSql('mysql');
  const pgStatusSql = buildCheckStatusSql('pg');
  const mysqlStatusRows = await executeMySql(mysqlPool, mysqlStatusSql, [userId]);
  const pgStatusRows = (await executePg(pgPool, pgStatusSql, [userId])).map(remapPgUserRow);
  flows.push(evaluateFlowParity('checkStatus', { userId }, mysqlStatusRows, pgStatusRows, { previewLimit }));

  // Flow 2: getUserByName (login lookup)
  if (userName) {
    const mysqlNameSql = buildGetUserByNameSql('mysql');
    const pgNameSql = buildGetUserByNameSql('pg');
    const mysqlNameRows = await executeMySql(mysqlPool, mysqlNameSql, [userName]);
    const pgNameRows = (await executePg(pgPool, pgNameSql, [userName])).map(remapPgUserRow);
    flows.push(evaluateFlowParity('getUserByName', { userName }, mysqlNameRows, pgNameRows, { previewLimit }));
  }

  // Flow 3: getProfileById (user profile)
  const mysqlProfileSql = buildGetProfileByIdSql('mysql');
  const pgProfileSql = buildGetProfileByIdSql('pg');
  const mysqlProfileRows = await executeMySql(mysqlPool, mysqlProfileSql, [userId]);
  const pgProfileRows = (await executePg(pgPool, pgProfileSql, [userId])).map(remapPgUserRow);
  flows.push(evaluateFlowParity('getProfileById', { userId }, mysqlProfileRows, pgProfileRows, { previewLimit }));

  // Flow 4: getLikedById (user likes)
  const mysqlLikedSql = buildGetLikedByIdSql('mysql');
  const pgLikedSql = buildGetLikedByIdSql('pg');
  const mysqlLikedRows = await executeMySql(mysqlPool, mysqlLikedSql, [userId]);
  const pgLikedRows = (await executePg(pgPool, pgLikedSql, [userId])).map(remapPgUserRow);
  flows.push(evaluateFlowParity('getLikedById', { userId }, mysqlLikedRows, pgLikedRows, { previewLimit }));

  // Flow 5: getFollowInfo (follow data)
  const mysqlFollowSql = buildGetFollowInfoSql('mysql');
  const pgFollowSql = buildGetFollowInfoSql('pg');
  const mysqlFollowRows = await executeMySql(mysqlPool, mysqlFollowSql, [userId]);
  const pgFollowRows = (await executePg(pgPool, pgFollowSql, [userId])).map(remapPgUserRow);
  flows.push(evaluateFlowParity('getFollowInfo', { userId }, mysqlFollowRows, pgFollowRows, { previewLimit }));

  // Flow 6: findUserByEmail (oauth)
  const sampleEmail = await fetchSampleEmail(mysqlPool, userId);
  if (sampleEmail) {
    const mysqlEmailSql = buildFindUserByEmailSql('mysql');
    const pgEmailSql = buildFindUserByEmailSql('pg');
    const mysqlEmailRows = await executeMySql(mysqlPool, mysqlEmailSql, [sampleEmail]);
    const pgEmailRows = (await executePg(pgPool, pgEmailSql, [sampleEmail])).map(remapPgUserRow);
    flows.push(evaluateFlowParity('findUserByEmail', { email: sampleEmail }, mysqlEmailRows, pgEmailRows, { previewLimit }));
  }

  const stopConditions = {
    countMismatch: flows.some((f) => f.stopConditions.countMismatch),
    orderMismatch: flows.some((f) => f.stopConditions.orderMismatch),
    structureMismatch: flows.some((f) => f.stopConditions.structureMismatch),
  };

  return {
    isSuccess: flows.every((f) => f.isMatched),
    userId,
    userName: userName || null,
    stopConditions,
    flows,
  };
};

const fetchSampleEmail = async (mysqlPool, userId) => {
  const rows = await executeMySql(
    mysqlPool,
    'SELECT email FROM profile WHERE user_id = ? AND email IS NOT NULL LIMIT 1;',
    [userId]
  );
  return rows[0]?.email || null;
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatUserAuthParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((f) => !f.isMatched);

  lines.push(`User/auth parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`User: ${report.userId} (${report.userName || 'auto-sampled'})`);

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

    const report = await buildUserAuthParityReport(mysqlPool, pgPool, {
      userId: userId ?? undefined,
      userName: runtime.args['user-name'] || undefined,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatUserAuthParitySummary(report));

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
    console.error('User/auth parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildUserAuthParityReport,
  formatUserAuthParitySummary,
  remapPgUserRow,
};
