const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-history-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected history parity script to exist');
  return require(parityScriptPath);
};

test('buildHistoryParityReport validates double upsert idempotency and getUserHistory parity', async () => {
  const { buildHistoryParityReport } = loadParityScript();

  let mysqlPairCount = 0;
  let pgPairCount = 0;
  const mysqlCalls = [];
  const pgCalls = [];

  const mysqlPool = {
    async query(sql, params) {
      mysqlCalls.push({ sql, params });

      if (/SELECT COUNT\(\*\) AS cnt FROM article_history WHERE user_id = \? AND article_id = \?/i.test(sql)) {
        return [[{ cnt: mysqlPairCount }]];
      }

      if (/INSERT INTO article_history/i.test(sql) && /ON DUPLICATE KEY UPDATE/i.test(sql)) {
        if (mysqlPairCount === 0) {
          mysqlPairCount = 1;
        }
        return [[{ affectedRows: 1 }]];
      }

      if (/FROM article_history ah/i.test(sql) && /ORDER BY ah\.update_at DESC/i.test(sql)) {
        return [
          [
            {
              id: 1,
              articleId: 20,
              title: 'History parity',
              author: '{"id":2,"name":"bob","avatarUrl":"https://cdn.example/a.png"}',
              content: 'body',
              views: 5,
              status: 1,
              likes: 0,
              commentCount: 0,
              cover: 'https://api.example/article/images/c.png?type=small',
              articleUrl: 'https://app.example/article/20',
              createAt: '2026-04-06 00:00:00',
              updateAt: '2026-04-06 01:00:00',
              articleCreateAt: '2026-04-05 00:00:00',
            },
          ],
        ];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql, params) {
      pgCalls.push({ sql, params });

      if (/SELECT COUNT\(\*\)::int AS cnt FROM article_history WHERE user_id = \$1 AND article_id = \$2/i.test(sql)) {
        return { rows: [{ cnt: pgPairCount }] };
      }

      if (/INSERT INTO article_history/i.test(sql) && /ON CONFLICT/i.test(sql)) {
        if (pgPairCount === 0) {
          pgPairCount = 1;
        }
        return { rows: [], rowCount: 1 };
      }

      if (/FROM article_history ah/i.test(sql) && /ORDER BY ah\.update_at DESC/i.test(sql)) {
        return {
          rows: [
            {
              id: 1,
              articleid: 20,
              title: 'History parity',
              author: { id: 2, name: 'bob', avatarUrl: 'https://cdn.example/a.png' },
              content: 'body',
              views: 5,
              status: 1,
              likes: '0',
              commentcount: '0',
              cover: 'https://api.example/article/images/c.png?type=small',
              articleurl: 'https://app.example/article/20',
              createat: new Date('2026-04-06T00:00:00.000Z'),
              updateat: new Date('2026-04-06T01:00:00.000Z'),
              articlecreateat: new Date('2026-04-05T00:00:00.000Z'),
            },
          ],
        };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildHistoryParityReport(mysqlPool, pgPool, {
    baseURL: 'https://api.example',
    redirectURL: 'https://app.example',
    userId: 100,
    articleId: 20,
    historyOffset: 0,
    historyLimit: 10,
  });

  assert.equal(report.isSuccess, true);
  assert.equal(report.upsertEvidence.mysql.idempotent, true);
  assert.equal(report.upsertEvidence.pg.idempotent, true);
  assert.equal(report.upsertEvidence.countsMatch, true);
  assert.equal(report.upsertEvidence.duplicatePairRows.mysql, false);
  assert.equal(report.upsertEvidence.duplicatePairRows.pg, false);

  const historyFlow = report.flows.find((f) => f.flow === 'getUserHistory');
  assert.ok(historyFlow);
  assert.equal(historyFlow.isMatched, true);

  assert.equal(
    mysqlCalls.some(({ sql }) => /INSERT INTO article_history/i.test(sql)),
    true,
    'Expected MySQL addHistory SQL to run twice'
  );
  assert.equal(
    pgCalls.some(({ sql }) => /\$/.test(sql) && /INSERT INTO article_history/i.test(sql)),
    true,
    'Expected PostgreSQL addHistory to use converted placeholders'
  );
});

test('buildHistoryParityReport runs getUserHistory parity before upserts so divergent update_at after writes does not false-fail read parity', async () => {
  const { buildHistoryParityReport } = loadParityScript();

  let mysqlPairCount = 0;
  let pgPairCount = 0;
  let insertRoundTripCount = 0;

  const bumpInsertCount = () => {
    insertRoundTripCount += 1;
  };

  const mysqlPool = {
    async query(sql) {
      if (/SELECT COUNT\(\*\) AS cnt FROM article_history WHERE user_id = \? AND article_id = \?/i.test(sql)) {
        return [[{ cnt: mysqlPairCount }]];
      }

      if (/INSERT INTO article_history/i.test(sql) && /ON DUPLICATE KEY UPDATE/i.test(sql)) {
        bumpInsertCount();
        if (mysqlPairCount === 0) {
          mysqlPairCount = 1;
        }
        return [[{ affectedRows: 1 }]];
      }

      if (/FROM article_history ah/i.test(sql) && /ORDER BY ah\.update_at DESC/i.test(sql)) {
        if (insertRoundTripCount >= 4) {
          return [
            [
              {
                id: 1,
                articleId: 20,
                title: 'Order test',
                author: '{"id":2,"name":"bob","avatarUrl":"https://cdn.example/a.png"}',
                content: 'body',
                views: 5,
                status: 1,
                likes: 0,
                commentCount: 0,
                cover: 'https://api.example/article/images/c.png?type=small',
                articleUrl: 'https://app.example/article/20',
                createAt: '2026-04-06 00:00:00',
                updateAt: '2026-04-06 12:00:00',
                articleCreateAt: '2026-04-05 00:00:00',
              },
            ],
          ];
        }

        return [
          [
            {
              id: 1,
              articleId: 20,
              title: 'Order test',
              author: '{"id":2,"name":"bob","avatarUrl":"https://cdn.example/a.png"}',
              content: 'body',
              views: 5,
              status: 1,
              likes: 0,
              commentCount: 0,
              cover: 'https://api.example/article/images/c.png?type=small',
              articleUrl: 'https://app.example/article/20',
              createAt: '2026-04-06 00:00:00',
              updateAt: '2026-04-06 01:00:00',
              articleCreateAt: '2026-04-05 00:00:00',
            },
          ],
        ];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/SELECT COUNT\(\*\)::int AS cnt FROM article_history WHERE user_id = \$1 AND article_id = \$2/i.test(sql)) {
        return { rows: [{ cnt: pgPairCount }] };
      }

      if (/INSERT INTO article_history/i.test(sql) && /ON CONFLICT/i.test(sql)) {
        bumpInsertCount();
        if (pgPairCount === 0) {
          pgPairCount = 1;
        }
        return { rows: [], rowCount: 1 };
      }

      if (/FROM article_history ah/i.test(sql) && /ORDER BY ah\.update_at DESC/i.test(sql)) {
        if (insertRoundTripCount >= 4) {
          return {
            rows: [
              {
                id: 1,
                articleid: 20,
                title: 'Order test',
                author: { id: 2, name: 'bob', avatarUrl: 'https://cdn.example/a.png' },
                content: 'body',
                views: 5,
                status: 1,
                likes: '0',
                commentcount: '0',
                cover: 'https://api.example/article/images/c.png?type=small',
                articleurl: 'https://app.example/article/20',
                createat: new Date('2026-04-06T00:00:00.000Z'),
                updateat: new Date('2026-04-06T15:00:00.000Z'),
                articlecreateat: new Date('2026-04-05T00:00:00.000Z'),
              },
            ],
          };
        }

        return {
          rows: [
            {
              id: 1,
              articleid: 20,
              title: 'Order test',
              author: { id: 2, name: 'bob', avatarUrl: 'https://cdn.example/a.png' },
              content: 'body',
              views: 5,
              status: 1,
              likes: '0',
              commentcount: '0',
              cover: 'https://api.example/article/images/c.png?type=small',
              articleurl: 'https://app.example/article/20',
              createat: new Date('2026-04-06T00:00:00.000Z'),
              updateat: new Date('2026-04-06T01:00:00.000Z'),
              articlecreateat: new Date('2026-04-05T00:00:00.000Z'),
            },
          ],
        };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildHistoryParityReport(mysqlPool, pgPool, {
    baseURL: 'https://api.example',
    redirectURL: 'https://app.example',
    userId: 100,
    articleId: 20,
    historyOffset: 0,
    historyLimit: 10,
  });

  assert.equal(report.isSuccess, true, 'Read parity should use pre-upsert snapshot; upsert evidence should still pass');
  const historyFlow = report.flows.find((f) => f.flow === 'getUserHistory');
  assert.ok(historyFlow);
  assert.equal(historyFlow.isMatched, true);
  assert.equal(report.flows.find((f) => f.flow === 'addHistory:doubleUpsert')?.isMatched, true);
});

test('buildHistoryParityReport fails upsert when writes leave zero rows on both engines (0→0→0 vacuous idempotency)', async () => {
  const { buildHistoryParityReport } = loadParityScript();

  const mysqlPool = {
    async query(sql) {
      if (/SELECT COUNT\(\*\) AS cnt FROM article_history WHERE user_id = \? AND article_id = \?/i.test(sql)) {
        return [[{ cnt: 0 }]];
      }

      if (/INSERT INTO article_history/i.test(sql) && /ON DUPLICATE KEY UPDATE/i.test(sql)) {
        return [[{ affectedRows: 0 }]];
      }

      if (/FROM article_history ah/i.test(sql) && /ORDER BY ah\.update_at DESC/i.test(sql)) {
        return [[]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/SELECT COUNT\(\*\)::int AS cnt FROM article_history WHERE user_id = \$1 AND article_id = \$2/i.test(sql)) {
        return { rows: [{ cnt: 0 }] };
      }

      if (/INSERT INTO article_history/i.test(sql) && /ON CONFLICT/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      if (/FROM article_history ah/i.test(sql) && /ORDER BY ah\.update_at DESC/i.test(sql)) {
        return { rows: [] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildHistoryParityReport(mysqlPool, pgPool, {
    baseURL: 'https://api.example',
    redirectURL: 'https://app.example',
    userId: 7,
    articleId: 9,
    historyOffset: 0,
    historyLimit: 5,
  });

  assert.equal(report.isSuccess, false);
  const upsertFlow = report.flows.find((f) => f.flow === 'addHistory:doubleUpsert');
  assert.ok(upsertFlow);
  assert.equal(upsertFlow.isMatched, false);
  assert.equal(upsertFlow.stopConditions.missingPersistedRow, true);
  assert.equal(report.upsertEvidence.bothEnginesPersistRow, false);
  assert.equal(report.upsertEvidence.pairRowPersisted.mysql, false);
  assert.equal(report.upsertEvidence.pairRowPersisted.pg, false);
});

test('formatHistoryParitySummary surfaces failing upsert stop conditions', () => {
  const { formatHistoryParitySummary } = loadParityScript();

  const summary = formatHistoryParitySummary({
    isSuccess: false,
    userId: 1,
    articleId: 2,
    upsertEvidence: {
      mysql: {
        countBefore: 0,
        countAfterFirst: 1,
        countAfterSecond: 2,
        idempotent: false,
      },
      pg: {
        countBefore: 0,
        countAfterFirst: 1,
        countAfterSecond: 1,
        idempotent: true,
      },
      countsMatch: false,
      duplicatePairRows: { mysql: false, pg: false },
      pairRowPersisted: { mysql: true, pg: true },
      bothEnginesPersistRow: true,
    },
    flows: [
      {
        flow: 'addHistory:doubleUpsert',
        input: { userId: 1, articleId: 2 },
        isMatched: false,
        stopConditions: {
          countMismatch: true,
          orderMismatch: false,
          missingPersistedRow: false,
          structureMismatch: true,
        },
      },
      {
        flow: 'getUserHistory',
        input: { userId: 1, offset: 0, limit: 5 },
        isMatched: true,
        stopConditions: {
          countMismatch: false,
          orderMismatch: false,
          structureMismatch: false,
        },
      },
    ],
  });

  assert.match(summary, /History parity: FAIL/);
  assert.match(summary, /addHistory:doubleUpsert/);
});
