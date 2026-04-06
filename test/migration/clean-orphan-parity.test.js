const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-clean-orphan-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected clean-orphan parity script to exist');
  return require(parityScriptPath);
};

const makeOrphanRow = (id, overrides = {}) => ({
  id,
  filename: `orphan_${id}.png`,
  mimetype: 'image/png',
  size: 512,
  createTime: '2026-01-01 00:00:00',
  age_in_units: 100,
  ...overrides,
});

const makePgOrphanRow = (id, overrides = {}) => ({
  id,
  filename: `orphan_${id}.png`,
  mimetype: 'image/png',
  size: 512,
  createtime: new Date('2026-01-01T00:00:00.000Z'),
  age_in_units: 100,
  ...overrides,
});

const buildMySqlStub = (tracker = {}) => ({
  async execute(sql, params) {
    if (/file_type = \?[\s\S]*image/i.test(sql) || (params.includes('image') && /article_id IS NULL/i.test(sql))) {
      return [tracker.imageOrphans ?? [makeOrphanRow(1)]];
    }
    if (/file_type = \?[\s\S]*video/i.test(sql) || (params.includes('video') && /article_id IS NULL/i.test(sql))) {
      return [tracker.videoOrphans ?? []];
    }
    throw new Error(`Unexpected MySQL execute: ${sql}`);
  },
});

const buildPgStub = (tracker = {}) => ({
  async query(sql, params) {
    if (params.includes('image') && /article_id IS NULL/i.test(sql)) {
      return { rows: tracker.imageOrphans ?? [makePgOrphanRow(1)] };
    }
    if (params.includes('video') && /article_id IS NULL/i.test(sql)) {
      return { rows: tracker.videoOrphans ?? [] };
    }
    throw new Error(`Unexpected PG query: ${sql}`);
  },
});

test('buildCleanOrphanParityReport verifies orphan file queries on both engines', async () => {
  const { buildCleanOrphanParityReport } = loadParityScript();

  const report = await buildCleanOrphanParityReport(
    buildMySqlStub(),
    buildPgStub(),
    { thresholdValue: 0, thresholdUnit: 'SECOND' }
  );

  assert.equal(report.isSuccess, true);
  const flowNames = report.flows.map((f) => f.flow);
  assert.ok(flowNames.includes('findOrphanFiles:image'));
  assert.ok(flowNames.includes('findOrphanFiles:video'));
});

test('buildCleanOrphanParityReport detects countMismatch in orphan images', async () => {
  const { buildCleanOrphanParityReport } = loadParityScript();

  const report = await buildCleanOrphanParityReport(
    buildMySqlStub({ imageOrphans: [makeOrphanRow(1), makeOrphanRow(2)] }),
    buildPgStub({ imageOrphans: [makePgOrphanRow(1)] }),
    { thresholdValue: 0, thresholdUnit: 'SECOND' }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.countMismatch, true);
});

test('formatCleanOrphanParitySummary produces readable output', () => {
  const { formatCleanOrphanParitySummary } = loadParityScript();

  const summary = formatCleanOrphanParitySummary({
    isSuccess: true,
    thresholdValue: 0,
    thresholdUnit: 'SECOND',
    flows: [
      { flow: 'findOrphanFiles:image', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
      { flow: 'findOrphanFiles:video', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
    ],
    stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false },
  });

  assert.match(summary, /Clean-orphan parity: PASS/);
  assert.match(summary, /Flows checked: 2/);
});

test('formatCleanOrphanParitySummary surfaces failing flows', () => {
  const { formatCleanOrphanParitySummary } = loadParityScript();

  const summary = formatCleanOrphanParitySummary({
    isSuccess: false,
    thresholdValue: 0,
    thresholdUnit: 'SECOND',
    flows: [
      { flow: 'findOrphanFiles:image', isMatched: false, input: { fileType: 'image' }, stopConditions: { countMismatch: true, orderMismatch: false, structureMismatch: false } },
    ],
    stopConditions: { countMismatch: true, orderMismatch: false, structureMismatch: false },
  });

  assert.match(summary, /Clean-orphan parity: FAIL/);
  assert.match(summary, /findOrphanFiles:image/);
});
