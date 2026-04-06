const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-file-meta-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected file-meta parity script to exist');
  return require(parityScriptPath);
};

const makeMyImageRow = (id, overrides = {}) => ({
  id,
  filename: `img_${id}.png`,
  mimetype: 'image/png',
  size: 1024,
  is_cover: 0,
  width: 800,
  height: 600,
  ...overrides,
});

const makePgImageRow = (id, overrides = {}) => ({
  id,
  filename: `img_${id}.png`,
  mimetype: 'image/png',
  size: 1024,
  is_cover: false,
  width: 800,
  height: 600,
  ...overrides,
});

const makeMyVideoRow = (id, overrides = {}) => ({
  id,
  filename: `vid_${id}.mp4`,
  mimetype: 'video/mp4',
  size: 10240,
  poster: null,
  duration: 120,
  width: 1920,
  height: 1080,
  bitrate: 5000,
  format: 'mp4',
  transcode_status: 'completed',
  ...overrides,
});

const makePgVideoRow = (id, overrides = {}) => ({
  id,
  filename: `vid_${id}.mp4`,
  mimetype: 'video/mp4',
  size: 10240,
  poster: null,
  duration: 120,
  width: 1920,
  height: 1080,
  bitrate: 5000,
  format: 'mp4',
  transcode_status: 'completed',
  ...overrides,
});

const buildMySqlStub = (tracker = {}) => ({
  async execute(sql, params) {
    if (/file_type = 'image'/i.test(sql) && /im\.is_cover/i.test(sql)) {
      return [tracker.imageRows ?? [makeMyImageRow(1)]];
    }
    if (/file_type = 'video'/i.test(sql) && /vm\.poster/i.test(sql)) {
      return [tracker.videoRows ?? [makeMyVideoRow(1)]];
    }
    if (/DISTINCT[\s\S]*article_id/i.test(sql)) {
      return [[{ articleId: 21 }]];
    }
    throw new Error(`Unexpected MySQL execute: ${sql}`);
  },
});

const buildPgStub = (tracker = {}) => ({
  async query(sql, params) {
    if (/file_type = 'image'/i.test(sql) && /im\.is_cover/i.test(sql)) {
      return { rows: tracker.imageRows ?? [makePgImageRow(1)] };
    }
    if (/file_type = 'video'/i.test(sql) && /vm\.poster/i.test(sql)) {
      return { rows: tracker.videoRows ?? [makePgVideoRow(1)] };
    }
    throw new Error(`Unexpected PG query: ${sql}`);
  },
});

test('buildFileMetaParityReport verifies image and video read flows', async () => {
  const { buildFileMetaParityReport } = loadParityScript();

  const report = await buildFileMetaParityReport(
    buildMySqlStub(),
    buildPgStub(),
    { articleId: 21 }
  );

  assert.equal(report.isSuccess, true);
  const flowNames = report.flows.map((f) => f.flow);
  assert.ok(flowNames.includes('getArticleImages'));
  assert.ok(flowNames.includes('getArticleVideos'));
});

test('buildFileMetaParityReport detects countMismatch in images', async () => {
  const { buildFileMetaParityReport } = loadParityScript();

  const report = await buildFileMetaParityReport(
    buildMySqlStub({ imageRows: [makeMyImageRow(1), makeMyImageRow(2)] }),
    buildPgStub({ imageRows: [makePgImageRow(1)] }),
    { articleId: 21 }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.countMismatch, true);
});

test('formatFileMetaParitySummary produces readable output', () => {
  const { formatFileMetaParitySummary } = loadParityScript();

  const summary = formatFileMetaParitySummary({
    isSuccess: true,
    articleId: 21,
    flows: [
      { flow: 'getArticleImages', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
      { flow: 'getArticleVideos', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
    ],
    stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false },
  });

  assert.match(summary, /File\/meta parity: PASS/);
  assert.match(summary, /Flows checked: 2/);
});

test('buildFileMetaParityReport auto-samples article from MySQL', async () => {
  const { buildFileMetaParityReport } = loadParityScript();
  let sampled = false;

  const mysqlPool = {
    async execute(sql, params) {
      if (/DISTINCT[\s\S]*article_id/i.test(sql)) {
        sampled = true;
        return [[{ articleId: 21 }]];
      }
      if (/file_type = 'image'/i.test(sql) && /im\.is_cover/i.test(sql)) {
        return [[makeMyImageRow(1)]];
      }
      if (/file_type = 'video'/i.test(sql) && /vm\.poster/i.test(sql)) {
        return [[makeMyVideoRow(1)]];
      }
      throw new Error(`Unexpected MySQL execute: ${sql}`);
    },
  };

  const report = await buildFileMetaParityReport(mysqlPool, buildPgStub(), {});

  assert.equal(sampled, true);
  assert.equal(report.isSuccess, true);
});
