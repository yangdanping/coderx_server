const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-comment-write-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected comment write parity script to exist');
  return require(parityScriptPath);
};

const makeMyCommentRow = (id, overrides = {}) => ({
  id,
  content: 'parity_write_test',
  status: 0,
  cid: null,
  rid: null,
  articleId: 9,
  createAt: '2026-04-06 12:00:00',
  author: '{"id":1,"name":"tester","avatarUrl":null}',
  likes: 0,
  replyTo: null,
  ...overrides,
});

const makePgCommentRow = (id, overrides = {}) => ({
  id,
  content: 'parity_write_test',
  status: 0,
  cid: null,
  rid: null,
  articleid: 9,
  createat: new Date('2026-04-06T12:00:00.000Z'),
  author: { id: 1, name: 'tester', avatarUrl: null },
  likes: '0',
  replyto: null,
  ...overrides,
});

const buildMySqlStub = (tracker) => {
  let insertCounter = 1001;
  return {
    async execute(sql, params) {
      if (/INSERT INTO comment/i.test(sql)) {
        const id = insertCounter++;
        tracker.inserts.push(id);
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/WHERE c\.id = \?/i.test(sql)) {
        const commentId = params[0];
        const idx = tracker.inserts.indexOf(commentId);
        if (idx === -1) return [[]];
        const overrides = tracker.readOverrides?.[idx] ?? {};
        return [[makeMyCommentRow(commentId, overrides)]];
      }
      if (/DELETE FROM comment WHERE id = \?/i.test(sql)) {
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
      if (/INSERT INTO comment.*RETURNING id/i.test(sql)) {
        const id = insertCounter++;
        tracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/WHERE c\.id = \$1/i.test(sql)) {
        const commentId = params[0];
        const idx = tracker.inserts.indexOf(commentId);
        if (idx === -1) return { rows: [] };
        const overrides = tracker.readOverrides?.[idx] ?? {};
        return { rows: [makePgCommentRow(commentId, overrides)] };
      }
      if (/DELETE FROM comment WHERE id = \$1/i.test(sql)) {
        tracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };
};

test('buildCommentWriteParityReport verifies addComment and addReply persist and match on both engines', async () => {
  const { buildCommentWriteParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  const report = await buildCommentWriteParityReport(
    buildMySqlStub(myTracker),
    buildPgStub(pgTracker),
    { userId: 1, articleId: 9, commentId: 101, replyId: 201 }
  );

  assert.equal(report.isSuccess, true);
  const flowNames = report.flows.map((f) => f.flow);
  assert.ok(flowNames.includes('addComment'));
  assert.ok(flowNames.includes('addReply:toComment'));
  assert.ok(flowNames.includes('addReply:toReply'));
  report.flows.forEach((f) => assert.equal(f.isMatched, true, `Flow ${f.flow} should match`));
  assert.equal(myTracker.deletes.length, myTracker.inserts.length, 'All MySQL inserts cleaned up');
  assert.equal(pgTracker.deletes.length, pgTracker.inserts.length, 'All PG inserts cleaned up');
});

test('buildCommentWriteParityReport detects missingPersistedRow when PG read-back returns null', async () => {
  const { buildCommentWriteParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  let pgInsertCounter = 2001;
  const pgPool = {
    async query(sql, params) {
      if (/INSERT INTO comment.*RETURNING id/i.test(sql)) {
        const id = pgInsertCounter++;
        pgTracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/WHERE c\.id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/DELETE FROM comment WHERE id = \$1/i.test(sql)) {
        pgTracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };

  const report = await buildCommentWriteParityReport(
    buildMySqlStub(myTracker),
    pgPool,
    { userId: 1, articleId: 9, commentId: 101, replyId: 201 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.missingPersistedRow, true);
});

test('buildCommentWriteParityReport detects structureMismatch when read-back content differs', async () => {
  const { buildCommentWriteParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [], readOverrides: { 0: { content: 'DIFFERENT' }, 1: { content: 'DIFFERENT' }, 2: { content: 'DIFFERENT' } } };

  const report = await buildCommentWriteParityReport(
    buildMySqlStub(myTracker),
    buildPgStub(pgTracker),
    { userId: 1, articleId: 9, commentId: 101, replyId: 201 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.structureMismatch, true);
});

test('formatCommentWriteParitySummary produces readable output for passing report', () => {
  const { formatCommentWriteParitySummary } = loadParityScript();

  const summary = formatCommentWriteParitySummary({
    isSuccess: true,
    userId: 1,
    articleId: 9,
    flows: [
      { flow: 'addComment', isMatched: true, stopConditions: { missingPersistedRow: false, structureMismatch: false } },
      { flow: 'addReply:toComment', isMatched: true, stopConditions: { missingPersistedRow: false, structureMismatch: false } },
      { flow: 'addReply:toReply', isMatched: true, stopConditions: { missingPersistedRow: false, structureMismatch: false } },
    ],
    stopConditions: { missingPersistedRow: false, structureMismatch: false },
    cleanup: { mysqlDeleted: 3, pgDeleted: 3 },
  });

  assert.match(summary, /Comment write parity: PASS/);
  assert.match(summary, /Flows checked: 3/);
});

test('formatCommentWriteParitySummary surfaces failing flows and stop conditions', () => {
  const { formatCommentWriteParitySummary } = loadParityScript();

  const summary = formatCommentWriteParitySummary({
    isSuccess: false,
    userId: 1,
    articleId: 9,
    flows: [
      { flow: 'addComment', isMatched: false, input: { userId: 1, articleId: 9 }, stopConditions: { missingPersistedRow: true, structureMismatch: false } },
    ],
    stopConditions: { missingPersistedRow: true, structureMismatch: false },
    cleanup: { mysqlDeleted: 1, pgDeleted: 1 },
  });

  assert.match(summary, /Comment write parity: FAIL/);
  assert.match(summary, /addComment/);
  assert.match(summary, /missingPersistedRow/);
});

test('buildCommentWriteParityReport auto-samples valid anchor from MySQL when no ids provided', async () => {
  const { buildCommentWriteParityReport } = loadParityScript();
  let sampled = false;
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  const mysqlPool = {
    async execute(sql, params) {
      if (/c\.user_id/i.test(sql) && /INNER JOIN.*article/i.test(sql)) {
        sampled = true;
        return [[{ userId: 1, articleId: 9, commentId: 101, replyId: 201 }]];
      }
      if (/INSERT INTO comment/i.test(sql)) {
        const id = 1001 + myTracker.inserts.length;
        myTracker.inserts.push(id);
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/WHERE c\.id = \?/i.test(sql)) {
        return [[makeMyCommentRow(params[0])]];
      }
      if (/DELETE FROM comment WHERE id = \?/i.test(sql)) {
        myTracker.deletes.push(params[0]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected MySQL execute: ${sql}`);
    },
  };

  const report = await buildCommentWriteParityReport(mysqlPool, buildPgStub(pgTracker), {});

  assert.equal(sampled, true, 'Should auto-sample anchor from MySQL');
  assert.equal(report.isSuccess, true);
});

test('buildCommentWriteParityReport performs cleanup even when a flow fails', async () => {
  const { buildCommentWriteParityReport } = loadParityScript();
  const myTracker = { inserts: [], deletes: [] };
  const pgTracker = { inserts: [], deletes: [] };

  let pgInsertCounter = 2001;
  const pgPool = {
    async query(sql, params) {
      if (/INSERT INTO comment.*RETURNING id/i.test(sql)) {
        const id = pgInsertCounter++;
        pgTracker.inserts.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/WHERE c\.id = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/DELETE FROM comment WHERE id = \$1/i.test(sql)) {
        pgTracker.deletes.push(params[0]);
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };

  const report = await buildCommentWriteParityReport(
    buildMySqlStub(myTracker),
    pgPool,
    { userId: 1, articleId: 9, commentId: 101, replyId: 201 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(myTracker.deletes.length, myTracker.inserts.length, 'MySQL cleanup still happens on failure');
  assert.equal(pgTracker.deletes.length, pgTracker.inserts.length, 'PG cleanup still happens on failure');
});
