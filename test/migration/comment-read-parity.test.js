const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-comment-read-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected comment read parity script to exist');
  return require(parityScriptPath);
};

test('buildCommentReadParityReport compares latest comments, hot comments, and replies using service-shaped payloads', async () => {
  const { buildCommentReadParityReport } = loadParityScript();
  const mysqlCalls = [];
  const pgCalls = [];

  const mysqlPool = {
    async query(sql, params) {
      mysqlCalls.push({ sql, params });

      if (/SELECT c\.article_id AS articleId, c\.id AS commentId/i.test(sql)) {
        return [[{ articleId: 9, commentId: 101 }]];
      }

      if (/WHERE c\.article_id = \?/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return [[{ id: 101, content: 'latest', createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (/WHERE c\.article_id = \?/i.test(sql) && /ORDER BY hot_comments\.likes DESC, hot_comments\.replyCount DESC, hot_comments\.createAt DESC, hot_comments\.id DESC/i.test(sql)) {
        return [[{ id: 101, content: 'hot', createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return [[{ id: 201, content: 'reply', cid: 101, rid: null, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', likes: 0, replyTo: '{"id":1,"name":"alice","content":"latest"}' }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC/i.test(sql) && /LIMIT \?/i.test(sql)) {
        return [[{ id: 201, content: 'reply', cid: 101, rid: null, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', likes: 0, replyTo: '{"id":1,"name":"alice","content":"latest"}' }]];
      }

      if (/SELECT COUNT\(\*\) AS replyCount FROM comment WHERE comment_id = \?/i.test(sql)) {
        return [[{ replyCount: 1 }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql, params) {
      pgCalls.push({ sql, params });

      if (/SELECT c\.article_id AS "articleId", c\.id AS "commentId"/i.test(sql)) {
        return { rows: [{ articleId: 9, commentId: 101 }] };
      }

      if (/WHERE c\.article_id = \$1/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return {
          rows: [{ id: 101, content: 'latest', createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }],
        };
      }

      if (/WHERE c\.article_id = \$1/i.test(sql) && /ORDER BY hot_comments\.likes DESC, hot_comments\.replyCount DESC, hot_comments\.createAt DESC, hot_comments\.id DESC/i.test(sql)) {
        return {
          rows: [{ id: 101, content: 'hot', createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }],
        };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return {
          rows: [{ id: 201, content: 'reply', cid: 101, rid: null, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, likes: '0', replyto: { id: 1, name: 'alice', content: 'latest' } }],
        };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC/i.test(sql) && /LIMIT \$2/i.test(sql)) {
        return {
          rows: [{ id: 201, content: 'reply', cid: 101, rid: null, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, likes: '0', replyto: { id: 1, name: 'alice', content: 'latest' } }],
        };
      }

      if (/SELECT COUNT\(\*\)::int AS "replyCount" FROM comment WHERE comment_id = \$1/i.test(sql)) {
        return { rows: [{ replyCount: 1 }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildCommentReadParityReport(mysqlPool, pgPool, {
    articleId: 9,
    commentId: 101,
    commentLimit: 5,
    replyLimit: 10,
  });

  assert.equal(report.isSuccess, true);
  assert.deepEqual(
    report.flows.map((flow) => flow.flow),
    ['getCommentList:latest', 'getCommentList:hot', 'getReplies']
  );
  const latestFlow = report.flows.find((flow) => flow.flow === 'getCommentList:latest');
  assert.ok(latestFlow);
  assert.equal(typeof latestFlow.mysqlPreview[0]?.items, 'string');
  assert.match(latestFlow.mysqlPreview[0]?.items || '', /replies/);
  assert.equal(latestFlow.mysqlPreview[0]?.hasMore, 'false');
  assert.equal(latestFlow.mysqlPreview[0]?.nextCursor, null);
  assert.equal(
    pgCalls.some(({ sql }) => /\$\d/.test(sql)),
    true,
    'Expected PostgreSQL comment parity queries to use converted $n placeholders'
  );
  assert.equal(mysqlCalls.length > 0, true);
  assert.equal(pgCalls.length > 0, true);
});

test('buildCommentReadParityReport normalizes PG lowercased aliases and JSON replyTo payloads', async () => {
  const { buildCommentReadParityReport } = loadParityScript();

  const mysqlPool = {
    async query(sql) {
      if (/SELECT c\.article_id AS articleId, c\.id AS commentId/i.test(sql)) {
        return [[{ articleId: 9, commentId: 101 }]];
      }

      if (/ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1, replies: '[{"id":201}]' }]];
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1, replies: '[{"id":201}]' }]];
      }

      if (
        /WHERE c\.comment_id = \?/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \?/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/SELECT COUNT\(\*\) AS replyCount FROM comment WHERE comment_id = \?/i.test(sql)) {
        return [[{ replyCount: 1 }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/SELECT c\.article_id AS "articleId", c\.id AS "commentId"/i.test(sql)) {
        return { rows: [{ articleId: 9, commentId: 101 }] };
      }

      if (/ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1', replies: [{ id: 201 }] }] };
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1', replies: [{ id: 201 }] }] };
      }

      if (
        /WHERE c\.comment_id = \$1/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \$2/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return {
          rows: [
            {
              id: 201,
              createat: new Date('2026-04-06T01:00:00.000Z'),
              author: { id: 2, name: 'bob' },
              replyto: { id: 1, name: 'alice', content: 'hello' },
              likes: '0',
            },
          ],
        };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/SELECT COUNT\(\*\)::int AS "replyCount" FROM comment WHERE comment_id = \$1/i.test(sql)) {
        return { rows: [{ replyCount: 1 }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildCommentReadParityReport(mysqlPool, pgPool, {
    articleId: 9,
    commentId: 101,
    commentLimit: 5,
    replyLimit: 10,
  });

  assert.equal(report.isSuccess, true);
});

test('formatCommentReadParitySummary surfaces failing stop conditions', () => {
  const { formatCommentReadParitySummary } = loadParityScript();

  const summary = formatCommentReadParitySummary({
    isSuccess: false,
    flows: [
      {
        flow: 'getCommentList:hot',
        input: { articleId: 9, limit: 5 },
        isMatched: false,
        stopConditions: {
          countMismatch: false,
          orderMismatch: true,
          structureMismatch: false,
        },
      },
    ],
  });

  assert.match(summary, /Comment read parity: FAIL/);
  assert.match(summary, /getCommentList:hot/);
  assert.match(summary, /orderMismatch/);
});

test('buildCommentReadParityReport samples a top-level comment that actually has replies when ids are not provided', async () => {
  const { buildCommentReadParityReport } = loadParityScript();
  let sampled = false;

  const mysqlPool = {
    async query(sql) {
      if (/SELECT c\.article_id AS articleId, c\.id AS commentId/i.test(sql) && /EXISTS/i.test(sql)) {
        sampled = true;
        return [[{ articleId: 9, commentId: 101 }]];
      }

      if (/WHERE c\.article_id = \?/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (
        /WHERE c\.comment_id = \?/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \?/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/SELECT COUNT\(\*\) AS replyCount FROM comment WHERE comment_id = \?/i.test(sql)) {
        return [[{ replyCount: 1 }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/WHERE c\.article_id = \$1/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (
        /WHERE c\.comment_id = \$1/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \$2/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/SELECT COUNT\(\*\)::int AS "replyCount" FROM comment WHERE comment_id = \$1/i.test(sql)) {
        return { rows: [{ replyCount: 1 }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildCommentReadParityReport(mysqlPool, pgPool, {});

  assert.equal(report.isSuccess, true);
  assert.equal(sampled, true);
});

test('buildCommentReadParityReport falls back to the same default limits as comment.service when non-positive limits are provided', async () => {
  const { buildCommentReadParityReport } = loadParityScript();
  const mysqlCalls = [];

  const mysqlPool = {
    async query(sql, params) {
      mysqlCalls.push({ sql, params });

      if (/WHERE c\.article_id = \?/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (
        /WHERE c\.comment_id = \?/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \?/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/SELECT COUNT\(\*\) AS replyCount FROM comment WHERE comment_id = \?/i.test(sql)) {
        return [[{ replyCount: 1 }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/WHERE c\.article_id = \$1/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (
        /WHERE c\.comment_id = \$1/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \$2/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/SELECT COUNT\(\*\)::int AS "replyCount" FROM comment WHERE comment_id = \$1/i.test(sql)) {
        return { rows: [{ replyCount: 1 }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildCommentReadParityReport(mysqlPool, pgPool, {
    articleId: 9,
    commentId: 101,
    commentLimit: 0,
    replyLimit: 0,
  });

  assert.equal(report.isSuccess, true);
  assert.equal(report.commentLimit, 5);
  assert.equal(report.replyLimit, 10);
  assert.equal(report.flows.find((flow) => flow.flow === 'getCommentList:latest')?.input.limit, 5);
  assert.equal(report.flows.find((flow) => flow.flow === 'getReplies')?.input.limit, 10);

  const listCall = mysqlCalls.find(({ sql }) => /WHERE c\.article_id = \?/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql));
  const repliesCall = mysqlCalls.find(({ sql }) => /WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql));
  assert.equal(listCall?.params.at(-1), '6');
  assert.equal(repliesCall?.params.at(-1), '11');
});

test('buildCommentReadParityReport prefers mysql execute when prepared LIMIT placeholders are involved', async () => {
  const { buildCommentReadParityReport } = loadParityScript();
  const mysqlCalls = [];

  const mysqlPool = {
    async execute(sql, params) {
      mysqlCalls.push({ method: 'execute', sql, params });

      if (/WHERE c\.article_id = \?/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (
        /WHERE c\.comment_id = \?/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \?/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return [[{ id: 201, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/SELECT COUNT\(\*\) AS replyCount FROM comment WHERE comment_id = \?/i.test(sql)) {
        return [[{ replyCount: 1 }]];
      }

      throw new Error(`Unexpected MySQL execute in test stub: ${sql}`);
    },
    async query() {
      throw new Error('Expected comment parity mysql path to use execute(), not query()');
    },
  };

  const pgPool = {
    async query(sql) {
      if (/WHERE c\.article_id = \$1/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return { rows: [{ id: 101, createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (
        /WHERE c\.comment_id = \$1/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \$2/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return { rows: [{ id: 201, createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/SELECT COUNT\(\*\)::int AS "replyCount" FROM comment WHERE comment_id = \$1/i.test(sql)) {
        return { rows: [{ replyCount: 1 }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildCommentReadParityReport(mysqlPool, pgPool, {
    articleId: 9,
    commentId: 101,
    commentLimit: 5,
    replyLimit: 10,
  });

  assert.equal(report.isSuccess, true);
  assert.equal(mysqlCalls.every(({ method }) => method === 'execute'), true);
});

test('buildCommentReadParityReport normalizes PostgreSQL string identifiers for comment rows and replies', async () => {
  const { buildCommentReadParityReport } = loadParityScript();

  const mysqlPool = {
    async query(sql) {
      if (/WHERE c\.article_id = \?/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return [[{ id: 101, createAt: '2026-04-06 00:00:00', author: '{"id":1,"name":"alice"}', likes: 2, replyCount: 1 }]];
      }

      if (
        /WHERE c\.comment_id = \?/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \?/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return [[{ id: 201, cid: 101, rid: 301, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/WHERE c\.comment_id = \?/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return [[{ id: 201, cid: 101, rid: 301, createAt: '2026-04-06 01:00:00', author: '{"id":2,"name":"bob"}', replyTo: '{"id":1,"name":"alice","content":"hello"}', likes: 0 }]];
      }

      if (/SELECT COUNT\(\*\) AS replyCount FROM comment WHERE comment_id = \?/i.test(sql)) {
        return [[{ replyCount: 1 }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/WHERE c\.article_id = \$1/i.test(sql) && /ORDER BY c\.create_at DESC, c\.id DESC/i.test(sql)) {
        return { rows: [{ id: '101', createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (/ORDER BY hot_comments\.likes DESC/i.test(sql)) {
        return { rows: [{ id: '101', createat: new Date('2026-04-06T00:00:00.000Z'), author: { id: 1, name: 'alice' }, likes: '2', replycount: '1' }] };
      }

      if (
        /WHERE c\.comment_id = \$1/i.test(sql) &&
        /ORDER BY c\.create_at ASC/i.test(sql) &&
        /LIMIT \$2/i.test(sql) &&
        !/ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)
      ) {
        return { rows: [{ id: '201', cid: '101', rid: '301', createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/WHERE c\.comment_id = \$1/i.test(sql) && /ORDER BY c\.create_at ASC, c\.id ASC/i.test(sql)) {
        return { rows: [{ id: '201', cid: '101', rid: '301', createat: new Date('2026-04-06T01:00:00.000Z'), author: { id: 2, name: 'bob' }, replyto: { id: 1, name: 'alice', content: 'hello' }, likes: '0' }] };
      }

      if (/SELECT COUNT\(\*\)::int AS "replyCount" FROM comment WHERE comment_id = \$1/i.test(sql)) {
        return { rows: [{ replyCount: 1 }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildCommentReadParityReport(mysqlPool, pgPool, {
    articleId: 9,
    commentId: 101,
    commentLimit: 5,
    replyLimit: 10,
  });

  assert.equal(report.isSuccess, true);
});
