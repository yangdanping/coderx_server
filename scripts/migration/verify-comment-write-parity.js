#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const {
  buildAddCommentSql,
  buildAddReplySql,
  buildGetCommentByIdSql,
} = require('../../src/service/comment.sql');
const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');

const PG_COMMENT_ALIAS_TO_CAMEL = {
  createat: 'createAt',
  updateat: 'updateAt',
  replycount: 'replyCount',
  replyto: 'replyTo',
  articleid: 'articleId',
  articletitle: 'articleTitle',
  articleurl: 'articleUrl',
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
};

const remapPgCommentRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_COMMENT_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
      return [mapped, value];
    })
  );
};

const tryParseJsonString = (value) => {
  if (typeof value !== 'string') return value;
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

const normalizeForCompare = (row) => {
  if (!row || typeof row !== 'object') return row;
  const clone = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || key === 'createAt' || key === 'updateAt') continue;
    if (value instanceof Date) {
      clone[key] = value.toISOString();
    } else if (typeof value === 'string') {
      const parsed = tryParseJsonString(value);
      clone[key] = parsed !== value ? normalizeForCompare(parsed) : value;
    } else if (typeof value === 'object' && value !== null) {
      clone[key] = normalizeForCompare(value);
    } else {
      clone[key] = value;
    }
  }
  return clone;
};

const coerceNumericFields = (row) => {
  if (!row || typeof row !== 'object') return;
  ['id', 'cid', 'rid', 'articleId', 'commentId', 'likes'].forEach((field) => {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      row[field] = Number(row[field]);
    }
  });
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

const readCommentById = async (pool, dialect, commentId) => {
  const sql = buildGetCommentByIdSql(dialect);
  if (dialect === 'pg') {
    const rows = await executePg(pool, sql, [commentId]);
    return rows[0] ? remapPgCommentRow(rows[0]) : null;
  }
  const rows = await executeMySql(pool, sql, [commentId]);
  return rows[0] || null;
};

const cleanupComment = async (pool, dialect, commentId) => {
  if (!commentId || Number.isNaN(commentId)) return;
  const sql = 'DELETE FROM comment WHERE id = ?';
  if (dialect === 'pg') {
    await executePg(pool, sql, [commentId]);
  } else {
    await executeMySql(pool, sql, [commentId]);
  }
};

const buildWriteFlowEvidence = (flowName, input, mysqlComment, pgComment) => {
  const mysqlPersisted = !!mysqlComment;
  const pgPersisted = !!pgComment;
  const bothPersisted = mysqlPersisted && pgPersisted;

  let structureMatch = false;
  if (bothPersisted) {
    const mysqlNorm = normalizeForCompare(mysqlComment);
    const pgNorm = normalizeForCompare(pgComment);
    coerceNumericFields(mysqlNorm);
    coerceNumericFields(pgNorm);
    structureMatch = stableStringify(mysqlNorm) === stableStringify(pgNorm);
  }

  return {
    flow: flowName,
    input,
    isMatched: bothPersisted && structureMatch,
    stopConditions: {
      missingPersistedRow: !bothPersisted,
      structureMismatch: bothPersisted && !structureMatch,
    },
    mysqlPersisted,
    pgPersisted,
  };
};

const fetchSampleWriteAnchor = async (mysqlPool) => {
  const rows = await executeMySql(
    mysqlPool,
    `SELECT
       c.user_id AS userId,
       c.article_id AS articleId,
       c.id AS commentId,
       (SELECT r.id FROM comment r WHERE r.comment_id = c.id LIMIT 1) AS replyId
     FROM comment c
     INNER JOIN user u ON u.id = c.user_id
     INNER JOIN article a ON a.id = c.article_id
     WHERE c.comment_id IS NULL
       AND EXISTS (SELECT 1 FROM comment r WHERE r.comment_id = c.id)
     ORDER BY c.id
     LIMIT 1;`
  );
  return rows[0] || null;
};

const buildCommentWriteParityReport = async (mysqlPool, pgPool, options = {}) => {
  let userId = options.userId;
  let articleId = options.articleId;
  let commentId = options.commentId;
  let replyId = options.replyId;

  if (userId == null || articleId == null || commentId == null) {
    const sample = await fetchSampleWriteAnchor(mysqlPool);
    if (!sample) {
      throw new Error(
        'No sample (userId, articleId, commentId) from comment; pass --user-id, --article-id, and --comment-id explicitly.'
      );
    }
    userId = userId ?? sample.userId;
    articleId = articleId ?? sample.articleId;
    commentId = commentId ?? sample.commentId;
    replyId = replyId ?? sample.replyId;
  }

  const content = options.content || `parity_write_test`;
  const flows = [];
  const mysqlInsertedIds = [];
  const pgInsertedIds = [];

  try {
    // Flow 1: addComment
    const myCommentId = await insertMySql(mysqlPool, buildAddCommentSql('mysql'), [userId, articleId, content]);
    mysqlInsertedIds.push(myCommentId);
    const pgCommentId = await insertPg(pgPool, buildAddCommentSql('pg'), [userId, articleId, content]);
    pgInsertedIds.push(pgCommentId);

    const myComment = await readCommentById(mysqlPool, 'mysql', myCommentId);
    const pgComment = await readCommentById(pgPool, 'pg', pgCommentId);
    flows.push(buildWriteFlowEvidence('addComment', { userId, articleId }, myComment, pgComment));

    // Flow 2: addReply:toComment (reply to existing top-level comment, no reply_id)
    const myReplyId = await insertMySql(mysqlPool, buildAddReplySql('mysql', false), [userId, articleId, commentId, content]);
    mysqlInsertedIds.push(myReplyId);
    const pgReplyId = await insertPg(pgPool, buildAddReplySql('pg', false), [userId, articleId, commentId, content]);
    pgInsertedIds.push(pgReplyId);

    const myReply = await readCommentById(mysqlPool, 'mysql', myReplyId);
    const pgReply = await readCommentById(pgPool, 'pg', pgReplyId);
    flows.push(buildWriteFlowEvidence('addReply:toComment', { userId, articleId, commentId }, myReply, pgReply));

    // Flow 3: addReply:toReply (reply to an existing reply, with reply_id)
    const targetReplyId = replyId || commentId;
    const myReplyToReplyId = await insertMySql(mysqlPool, buildAddReplySql('mysql', true), [userId, articleId, commentId, targetReplyId, content]);
    mysqlInsertedIds.push(myReplyToReplyId);
    const pgReplyToReplyId = await insertPg(pgPool, buildAddReplySql('pg', true), [userId, articleId, commentId, targetReplyId, content]);
    pgInsertedIds.push(pgReplyToReplyId);

    const myReplyToReply = await readCommentById(mysqlPool, 'mysql', myReplyToReplyId);
    const pgReplyToReply = await readCommentById(pgPool, 'pg', pgReplyToReplyId);
    flows.push(buildWriteFlowEvidence('addReply:toReply', { userId, articleId, commentId, replyId: targetReplyId }, myReplyToReply, pgReplyToReply));
  } finally {
    for (const id of mysqlInsertedIds) {
      await cleanupComment(mysqlPool, 'mysql', id);
    }
    for (const id of pgInsertedIds) {
      await cleanupComment(pgPool, 'pg', id);
    }
  }

  const stopConditions = {
    missingPersistedRow: flows.some((f) => f.stopConditions.missingPersistedRow),
    structureMismatch: flows.some((f) => f.stopConditions.structureMismatch),
  };

  return {
    isSuccess: flows.every((f) => f.isMatched),
    userId,
    articleId,
    commentId,
    replyId: replyId || null,
    stopConditions,
    flows,
    cleanup: { mysqlDeleted: mysqlInsertedIds.length, pgDeleted: pgInsertedIds.length },
  };
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatCommentWriteParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((f) => !f.isMatched);

  lines.push(`Comment write parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`User/article: ${report.userId} / ${report.articleId}`);
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
    const articleId = parseOptionalId(runtime.args['article-id']);
    const commentId = parseOptionalId(runtime.args['comment-id']);
    const replyId = parseOptionalId(runtime.args['reply-id']);

    const report = await buildCommentWriteParityReport(mysqlPool, pgPool, {
      userId: userId ?? undefined,
      articleId: articleId ?? undefined,
      commentId: commentId ?? undefined,
      replyId: replyId ?? undefined,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatCommentWriteParitySummary(report));

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
    console.error('Comment write parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCommentWriteParityReport,
  formatCommentWriteParitySummary,
};
