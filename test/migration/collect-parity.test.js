const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-collect-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected collect parity script to exist');
  return require(parityScriptPath);
};

const makeMyCollectListRow = (id, overrides = {}) => ({
  id,
  name: `folder_${id}`,
  userId: 2,
  createAt: '2026-04-06 12:00:00',
  count: '[21,22]',
  ...overrides,
});

const makePgCollectListRow = (id, overrides = {}) => ({
  id,
  name: `folder_${id}`,
  userid: 2,
  createat: new Date('2026-04-06T12:00:00.000Z'),
  count: [21, 22],
  ...overrides,
});

const makeMyArticleRow = (overrides = {}) => ({
  collectedArticle: '[21,22,23]',
  ...overrides,
});

const makePgArticleRow = (overrides = {}) => ({
  collectedarticle: [21, 22, 23],
  ...overrides,
});

const makeMyCollectRow = (id, overrides = {}) => ({
  id,
  user_id: 2,
  name: 'parity_collect_test_123',
  create_at: '2026-04-06 12:00:00',
  update_at: '2026-04-06 12:00:00',
  ...overrides,
});

const makePgCollectRow = (id, overrides = {}) => ({
  id,
  user_id: 2,
  name: 'parity_collect_test_123',
  create_at: new Date('2026-04-06T12:00:00.000Z'),
  update_at: new Date('2026-04-06T12:00:00.000Z'),
  ...overrides,
});

const buildMySqlStub = (tracker) => {
  let insertCounter = 1001;
  return {
    async execute(sql, params) {
      if (/INSERT INTO collect/i.test(sql)) {
        const id = insertCounter++;
        tracker.inserts.push(id);
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/FROM collect c[\s\S]*LEFT JOIN article_collect/i.test(sql)) {
        return [tracker.listRows ?? [makeMyCollectListRow(10)]];
      }
      if (/FROM article_collect ac[\s\S]*WHERE ac\.collect_id/i.test(sql)) {
        return [tracker.articleRows ?? [makeMyArticleRow()]];
      }
      if (/SELECT \* FROM collect WHERE id = \?/i.test(sql)) {
        const id = params[0];
        return [[makeMyCollectRow(id)]];
      }
      if (/DELETE FROM collect WHERE id = \?/i.test(sql)) {
        tracker.deletes.push(params[0]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected MySQL execute: ${sql}`);
    },
  };
};

const buildPgStub = (tracker) => {
  let insertCounter = 2001;
  return {
    async query(sql, params) {
      if (/INSERT INTO collect[\s\S]*RETURNING id/i.test(sql)) {
        const id = insertCounter++;
        tracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/FROM collect c[\s\S]*LEFT JOIN article_collect/i.test(sql)) {
        return { rows: tracker.listRows ?? [makePgCollectListRow(10)] };
      }
      if (/FROM article_collect ac[\s\S]*WHERE ac\.collect_id/i.test(sql)) {
        return { rows: tracker.articleRows ?? [makePgArticleRow()] };
      }
      if (/SELECT \* FROM collect WHERE id = \$1/i.test(sql)) {
        const id = params[0];
        return { rows: [makePgCollectRow(id)] };
      }
      if (/DELETE FROM collect WHERE id = \$1/i.test(sql)) {
        tracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };
};

test('buildCollectParityReport verifies read and write flows on both engines', async () => {
  const { buildCollectParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  const report = await buildCollectParityReport(
    buildMySqlStub(myTracker),
    buildPgStub(pgTracker),
    { userId: 2, collectId: 10 }
  );

  assert.equal(report.isSuccess, true);
  const flowNames = report.flows.map((f) => f.flow);
  assert.ok(flowNames.includes('getCollectList'));
  assert.ok(flowNames.includes('getCollectArticle'));
  assert.ok(flowNames.includes('addCollect'));
  report.flows.forEach((f) => assert.equal(f.isMatched, true, `Flow ${f.flow} should match`));
  assert.equal(myTracker.deletes.length, myTracker.inserts.length, 'All MySQL inserts cleaned up');
  assert.equal(pgTracker.deletes.length, pgTracker.inserts.length, 'All PG inserts cleaned up');
});

test('buildCollectParityReport detects missingPersistedRow when PG addCollect read-back returns empty', async () => {
  const { buildCollectParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  let pgInsertCounter = 2001;
  const pgPool = {
    async query(sql, params) {
      if (/INSERT INTO collect[\s\S]*RETURNING id/i.test(sql)) {
        const id = pgInsertCounter++;
        pgTracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/FROM collect c[\s\S]*LEFT JOIN article_collect/i.test(sql)) {
        return { rows: [makePgCollectListRow(10)] };
      }
      if (/FROM article_collect ac[\s\S]*WHERE ac\.collect_id/i.test(sql)) {
        return { rows: [makePgArticleRow()] };
      }
      if (/SELECT \* FROM collect WHERE id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/DELETE FROM collect WHERE id = \$1/i.test(sql)) {
        pgTracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };

  const report = await buildCollectParityReport(
    buildMySqlStub(myTracker),
    pgPool,
    { userId: 2, collectId: 10 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.missingPersistedRow, true);
});

test('buildCollectParityReport detects structureMismatch when read-back name differs', async () => {
  const { buildCollectParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  let pgInsertCounter = 2001;
  const pgPool = {
    async query(sql, params) {
      if (/INSERT INTO collect[\s\S]*RETURNING id/i.test(sql)) {
        const id = pgInsertCounter++;
        pgTracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/FROM collect c[\s\S]*LEFT JOIN article_collect/i.test(sql)) {
        return { rows: [makePgCollectListRow(10)] };
      }
      if (/FROM article_collect ac[\s\S]*WHERE ac\.collect_id/i.test(sql)) {
        return { rows: [makePgArticleRow()] };
      }
      if (/SELECT \* FROM collect WHERE id = \$1/i.test(sql)) {
        const id = params[0];
        return { rows: [makePgCollectRow(id, { name: 'DIFFERENT_NAME' })] };
      }
      if (/DELETE FROM collect WHERE id = \$1/i.test(sql)) {
        pgTracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };

  const report = await buildCollectParityReport(
    buildMySqlStub(myTracker),
    pgPool,
    { userId: 2, collectId: 10 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.structureMismatch, true);
});

test('formatCollectParitySummary produces readable output for passing report', () => {
  const { formatCollectParitySummary } = loadParityScript();

  const summary = formatCollectParitySummary({
    isSuccess: true,
    userId: 2,
    collectId: 10,
    flows: [
      { flow: 'getCollectList', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
      { flow: 'getCollectArticle', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
      { flow: 'addCollect', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, missingPersistedRow: false, structureMismatch: false } },
    ],
    stopConditions: { countMismatch: false, orderMismatch: false, missingPersistedRow: false, structureMismatch: false },
    cleanup: { mysqlDeleted: 1, pgDeleted: 1 },
  });

  assert.match(summary, /Collect parity: PASS/);
  assert.match(summary, /Flows checked: 3/);
});

test('formatCollectParitySummary surfaces failing flows', () => {
  const { formatCollectParitySummary } = loadParityScript();

  const summary = formatCollectParitySummary({
    isSuccess: false,
    userId: 2,
    collectId: 10,
    flows: [
      { flow: 'addCollect', isMatched: false, input: { userId: 2, name: 'test' }, stopConditions: { missingPersistedRow: true, structureMismatch: false } },
    ],
    stopConditions: { missingPersistedRow: true, structureMismatch: false },
    cleanup: { mysqlDeleted: 1, pgDeleted: 1 },
  });

  assert.match(summary, /Collect parity: FAIL/);
  assert.match(summary, /addCollect/);
  assert.match(summary, /missingPersistedRow/);
});

test('buildCollectParityReport auto-samples anchor from MySQL when no ids provided', async () => {
  const { buildCollectParityReport } = loadParityScript();
  let sampled = false;
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  const mysqlPool = {
    async execute(sql, params) {
      if (/FROM collect c[\s\S]*INNER JOIN[\s\S]*user/i.test(sql)) {
        sampled = true;
        return [[{ userId: 2, collectId: 10 }]];
      }
      if (/INSERT INTO collect/i.test(sql)) {
        const id = 1001 + myTracker.inserts.length;
        myTracker.inserts.push(id);
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/FROM collect c[\s\S]*LEFT JOIN article_collect/i.test(sql)) {
        return [[makeMyCollectListRow(10)]];
      }
      if (/FROM article_collect ac[\s\S]*WHERE ac\.collect_id/i.test(sql)) {
        return [[makeMyArticleRow()]];
      }
      if (/SELECT \* FROM collect WHERE id = \?/i.test(sql)) {
        return [[makeMyCollectRow(params[0])]];
      }
      if (/DELETE FROM collect WHERE id = \?/i.test(sql)) {
        myTracker.deletes.push(params[0]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected MySQL execute: ${sql}`);
    },
  };

  const report = await buildCollectParityReport(mysqlPool, buildPgStub(pgTracker), {});

  assert.equal(sampled, true, 'Should auto-sample anchor from MySQL');
  assert.equal(report.isSuccess, true);
});

test('buildCollectParityReport performs cleanup even when a flow fails', async () => {
  const { buildCollectParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  let pgInsertCounter = 2001;
  const pgPool = {
    async query(sql, params) {
      if (/INSERT INTO collect[\s\S]*RETURNING id/i.test(sql)) {
        const id = pgInsertCounter++;
        pgTracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/FROM collect c[\s\S]*LEFT JOIN article_collect/i.test(sql)) {
        return { rows: [makePgCollectListRow(10)] };
      }
      if (/FROM article_collect ac[\s\S]*WHERE ac\.collect_id/i.test(sql)) {
        return { rows: [makePgArticleRow()] };
      }
      if (/SELECT \* FROM collect WHERE id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/DELETE FROM collect WHERE id = \$1/i.test(sql)) {
        pgTracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };

  const report = await buildCollectParityReport(
    buildMySqlStub(myTracker),
    pgPool,
    { userId: 2, collectId: 10 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(myTracker.deletes.length, myTracker.inserts.length, 'MySQL cleanup still happens on failure');
  assert.equal(pgTracker.deletes.length, pgTracker.inserts.length, 'PG cleanup still happens on failure');
});
