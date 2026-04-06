#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const SqlUtils = require('../../src/utils/SqlUtils');
const { convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const {
  buildGetCommentListSql,
  buildGetRepliesSql,
  buildGetReplyPreviewSql,
} = require('../../src/service/comment.sql');
const { buildRuntimeConfig, closePools, createMySqlPool, createPgPool } = require('./phase2/lib/runtime');
const { evaluateFlowParity } = require('./verify-article-read-parity');

/** PostgreSQL folds unquoted SELECT aliases to lowercase; align keys with mysql2 for parity compare. */
const PG_COMMENT_ALIAS_TO_CAMEL = {
  createat: 'createAt',
  updateat: 'updateAt',
  replycount: 'replyCount',
  replyto: 'replyTo',
  articleid: 'articleId',
  articletitle: 'articleTitle',
  articleurl: 'articleUrl',
};

const COUNT_REPLIES_SQL_MYSQL = 'SELECT COUNT(*) AS replyCount FROM comment WHERE comment_id = ?';
const COUNT_REPLIES_SQL_PG = 'SELECT COUNT(*)::int AS "replyCount" FROM comment WHERE comment_id = ?';

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) {
    return null;
  }

  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(process.cwd(), inputPath);
};

const remapPgCommentRow = (row) => {
  if (!row || typeof row !== 'object') {
    return row;
  }

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const mapped = PG_COMMENT_ALIAS_TO_CAMEL[key.toLowerCase()] || key;
      return [mapped, value];
    })
  );
};

const applyBannedCommentContent = (row) => {
  if (!row || typeof row !== 'object') {
    return;
  }
  if (row.status) {
    row.content = '评论已被封禁';
  }
};

/** Align mysql2 numbers with pg string/bigint counts so nested stableStringify matches. */
const coerceCommentNumericFields = (row) => {
  if (!row || typeof row !== 'object') {
    return;
  }
  ['id', 'cid', 'rid', 'articleId', 'commentId'].forEach((field) => {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      row[field] = Number(row[field]);
    }
  });
  if (row.likes !== undefined && row.likes !== null) {
    row.likes = Number(row.likes);
  }
  if (row.replyCount !== undefined && row.replyCount !== null) {
    row.replyCount = Number(row.replyCount);
  }
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

const normalizeDialect = (dialect) => (dialect === 'pg' ? 'pg' : 'mysql');

const mapRowsForDialect = (dialect, rows) => {
  if (normalizeDialect(dialect) === 'pg') {
    return rows.map((row) => remapPgCommentRow(row));
  }
  return rows;
};

const fetchReplyPreviewForComment = async (pool, dialect, execute, commentId, replyPreviewLimit) => {
  const statement = buildGetReplyPreviewSql(normalizeDialect(dialect));
  const raw = await execute(pool, statement, [commentId, String(replyPreviewLimit)]);
  const rows = mapRowsForDialect(dialect, raw);
  rows.forEach((reply) => {
    coerceCommentNumericFields(reply);
    applyBannedCommentContent(reply);
  });
  return rows;
};

const assembleCommentListPayload = async (pool, dialect, execute, articleId, sort, normalizedLimit, replyPreviewLimit, cursor) => {
  const limitForHasMore = String(normalizedLimit + 1);
  const d = normalizeDialect(dialect);
  let queryParams = [articleId];
  let statement;

  if (sort === 'hot') {
    const { condition, params } = SqlUtils.buildHotCursorCondition(cursor);
    queryParams.push(...params, limitForHasMore);
    statement = buildGetCommentListSql(d, { sort: 'hot', cursorCondition: condition });
  } else {
    const isOldest = sort === 'oldest';
    const direction = isOldest ? 'ASC' : 'DESC';
    const { condition, params } = SqlUtils.buildTimeCursorCondition(cursor, direction);
    queryParams.push(...params, limitForHasMore);
    statement = buildGetCommentListSql(d, { sort, cursorCondition: condition, direction });
  }

  const rawComments = await execute(pool, statement, queryParams);
  const comments = mapRowsForDialect(dialect, rawComments);
  const hasMore = comments.length > normalizedLimit;
  const items = hasMore ? comments.slice(0, normalizedLimit) : comments;

  items.forEach((comment) => {
    coerceCommentNumericFields(comment);
    applyBannedCommentContent(comment);
  });

  for (const comment of items) {
    comment.replies = await fetchReplyPreviewForComment(pool, dialect, execute, comment.id, replyPreviewLimit);
  }

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    nextCursor = sort === 'hot' ? SqlUtils.buildHotNextCursor(items[items.length - 1]) : SqlUtils.buildNextCursor(items[items.length - 1]);
  }

  return {
    items,
    hasMore,
    nextCursor,
  };
};

const assembleGetRepliesPayload = async (pool, dialect, execute, commentId, normalizedLimit, cursor) => {
  const d = normalizeDialect(dialect);
  const queryParams = [commentId];
  const { condition, params } = SqlUtils.buildCursorCondition(cursor, 'ASC');
  queryParams.push(...params);
  const limitForHasMore = String(normalizedLimit + 1);
  queryParams.push(limitForHasMore);

  const statement = buildGetRepliesSql(d, { cursorCondition: condition });
  const rawReplies = await execute(pool, statement, queryParams);
  const replies = mapRowsForDialect(dialect, rawReplies);
  const hasMore = replies.length > normalizedLimit;
  const items = hasMore ? replies.slice(0, normalizedLimit) : replies;

  items.forEach((reply) => {
    coerceCommentNumericFields(reply);
    applyBannedCommentContent(reply);
  });

  const countSql = d === 'pg' ? COUNT_REPLIES_SQL_PG : COUNT_REPLIES_SQL_MYSQL;
  const countRows = await execute(pool, countSql, [commentId]);
  const replyCount = Number(countRows[0]?.replyCount ?? 0);

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    nextCursor = SqlUtils.buildNextCursor(items[items.length - 1]);
  }

  return {
    items,
    hasMore,
    nextCursor,
    replyCount,
  };
};

const fetchSampleCommentAnchor = async (mysqlPool) => {
  const rows = await executeMySql(
    mysqlPool,
    `SELECT c.article_id AS articleId, c.id AS commentId
     FROM comment c
     WHERE c.comment_id IS NULL
       AND c.article_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM comment reply
         WHERE reply.comment_id = c.id
       )
     ORDER BY c.id
     LIMIT 1;`
  );
  return rows[0] || null;
};

const normalizeLimit = (value, fallback) => {
  return Number(value) || fallback;
};

const buildCommentReadParityReport = async (mysqlPool, pgPool, options = {}) => {
  let articleId = options.articleId;
  let commentId = options.commentId;

  if (articleId == null || commentId == null) {
    const sample = await fetchSampleCommentAnchor(mysqlPool);
    if (!sample) {
      throw new Error(
        'No sample (articleId, commentId) from comment; pass --article-id and --comment-id explicitly.'
      );
    }
    articleId = sample.articleId;
    commentId = sample.commentId;
  }

  const commentLimit = normalizeLimit(options.commentLimit, 5);
  const replyLimit = normalizeLimit(options.replyLimit, 10);
  const replyPreviewLimit = normalizeLimit(options.replyPreviewLimit, 2);
  const listCursor = options.commentListCursor ?? null;
  const repliesCursor = options.repliesCursor ?? null;

  const flows = [];

  const mysqlLatestPayload = await assembleCommentListPayload(
    mysqlPool,
    'mysql',
    executeMySql,
    articleId,
    'latest',
    commentLimit,
    replyPreviewLimit,
    listCursor
  );
  const pgLatestPayload = await assembleCommentListPayload(
    pgPool,
    'pg',
    executePg,
    articleId,
    'latest',
    commentLimit,
    replyPreviewLimit,
    listCursor
  );
  flows.push(
    evaluateFlowParity(
      'getCommentList:latest',
      { articleId, limit: commentLimit, sort: 'latest', replyPreviewLimit },
      [mysqlLatestPayload],
      [pgLatestPayload],
      options
    )
  );

  const mysqlHotPayload = await assembleCommentListPayload(
    mysqlPool,
    'mysql',
    executeMySql,
    articleId,
    'hot',
    commentLimit,
    replyPreviewLimit,
    listCursor
  );
  const pgHotPayload = await assembleCommentListPayload(
    pgPool,
    'pg',
    executePg,
    articleId,
    'hot',
    commentLimit,
    replyPreviewLimit,
    listCursor
  );
  flows.push(
    evaluateFlowParity(
      'getCommentList:hot',
      { articleId, limit: commentLimit, sort: 'hot', replyPreviewLimit },
      [mysqlHotPayload],
      [pgHotPayload],
      options
    )
  );

  const mysqlReplies = await assembleGetRepliesPayload(
    mysqlPool,
    'mysql',
    executeMySql,
    commentId,
    replyLimit,
    repliesCursor
  );
  const pgReplies = await assembleGetRepliesPayload(pgPool, 'pg', executePg, commentId, replyLimit, repliesCursor);

  flows.push(
    evaluateFlowParity(
      'getReplies',
      { commentId, limit: replyLimit, cursor: repliesCursor },
      [mysqlReplies],
      [pgReplies],
      options
    )
  );

  const stopConditions = {
    countMismatch: flows.some((flow) => flow.stopConditions.countMismatch),
    orderMismatch: flows.some((flow) => flow.stopConditions.orderMismatch),
    structureMismatch: flows.some((flow) => flow.stopConditions.structureMismatch),
  };

  return {
    isSuccess: !stopConditions.countMismatch && !stopConditions.orderMismatch && !stopConditions.structureMismatch,
    articleId,
    commentId,
    commentLimit,
    replyLimit,
    replyPreviewLimit,
    stopConditions,
    flows,
  };
};

const formatStopConditions = (stopConditions) => {
  return Object.entries(stopConditions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
};

const formatCommentReadParitySummary = (report) => {
  const lines = [];
  const failingFlows = report.flows.filter((flow) => !flow.isMatched);

  lines.push(`Comment read parity: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Flows checked: ${report.flows.length}`);
  lines.push(`Article/comment: ${report.articleId} / ${report.commentId}`);

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

const parseOptionalId = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const main = async () => {
  const runtime = buildRuntimeConfig(process.argv.slice(2));
  const mysqlPool = createMySqlPool(runtime.mysqlConfig);
  const pgPool = createPgPool(runtime.pgConfig);

  try {
    const articleId = parseOptionalId(runtime.args['article-id']);
    const commentId = parseOptionalId(runtime.args['comment-id']);
    const commentLimit = parseOptionalId(runtime.args['comment-limit']) ?? runtime.sampleLimit;
    const replyLimit = parseOptionalId(runtime.args['reply-limit']) ?? 10;
    const replyPreviewLimit = parseOptionalId(runtime.args['reply-preview-limit']);

    const report = await buildCommentReadParityReport(mysqlPool, pgPool, {
      articleId: articleId ?? undefined,
      commentId: commentId ?? undefined,
      commentLimit,
      replyLimit,
      replyPreviewLimit: replyPreviewLimit ?? undefined,
    });
    const reportPath = writeReportFile(report, runtime.args['report-file']);

    console.log(`Loaded env files: ${runtime.loadedEnvFiles.length > 0 ? runtime.loadedEnvFiles.join(', ') : 'none'}`);
    console.log(formatCommentReadParitySummary(report));

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
    console.error('Comment read parity verification failed.');
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCommentReadParityReport,
  formatCommentReadParitySummary,
};
