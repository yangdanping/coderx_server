const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-user-auth-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected user-auth parity script to exist');
  return require(parityScriptPath);
};

const makeMyStatusRow = () => ({ status: 0 });
const makePgStatusRow = () => ({ status: 0 });

const makeMyUserRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  password: 'hashed', // pragma: allowlist secret
  status: 0,
  create_at: '2026-01-01 00:00:00',
  update_at: '2026-01-01 00:00:00',
  ...overrides,
});

const makePgUserRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  password: 'hashed', // pragma: allowlist secret
  status: 0,
  create_at: new Date('2026-01-01T00:00:00.000Z'),
  update_at: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const makeMyProfileRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  status: 0,
  avatarUrl: null,
  age: null,
  sex: null,
  email: 'test@example.com',
  career: null,
  address: null,
  articleCount: 5,
  commentCount: 10,
  ...overrides,
});

const makePgProfileRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  status: 0,
  avatarurl: null,
  age: null,
  sex: null,
  email: 'test@example.com',
  career: null,
  address: null,
  articlecount: '5',
  commentcount: '10',
  ...overrides,
});

const makeMyLikedRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  articleLiked: '[21,22]',
  commentLiked: '[60]',
  ...overrides,
});

const makePgLikedRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  articleliked: [21, 22],
  commentliked: [60],
  ...overrides,
});

const makeMyFollowRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  following: null,
  follower: null,
  ...overrides,
});

const makePgFollowRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  following: null,
  follower: null,
  ...overrides,
});

const makeMyEmailRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  profileEmail: 'test@example.com',
  ...overrides,
});

const makePgEmailRow = (overrides = {}) => ({
  id: 1,
  name: 'testuser',
  profileemail: 'test@example.com',
  ...overrides,
});

const buildMySqlStub = (tracker = {}) => ({
  async execute(sql, params) {
    if (/FROM user u[\s\S]*INNER JOIN profile/i.test(sql) && /LIMIT 1/i.test(sql)) {
      return [[{ userId: 1, userName: 'testuser' }]];
    }
    if (/SELECT status FROM user/i.test(sql)) {
      return [[makeMyStatusRow()]];
    }
    if (/SELECT \* FROM user WHERE name = \?/i.test(sql)) {
      return [[makeMyUserRow()]];
    }
    if (/FROM user u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE u\.id = \?/i.test(sql) && /articleCount/i.test(sql)) {
      return [[makeMyProfileRow()]];
    }
    if (/articleLiked[\s\S]*commentLiked/i.test(sql)) {
      return [[makeMyLikedRow()]];
    }
    if (/following[\s\S]*follower/i.test(sql)) {
      return [[makeMyFollowRow()]];
    }
    if (/SELECT email FROM profile/i.test(sql)) {
      return [[{ email: 'test@example.com' }]];
    }
    if (/FROM user u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE p\.email = \?/i.test(sql)) {
      return [[makeMyEmailRow()]];
    }
    throw new Error(`Unexpected MySQL execute: ${sql}`);
  },
});

const buildPgStub = (tracker = {}) => ({
  async query(sql, params) {
    if (/SELECT status FROM "user"/i.test(sql)) {
      return { rows: [makePgStatusRow()] };
    }
    if (/SELECT \* FROM "user" WHERE name = \$1/i.test(sql)) {
      return { rows: [makePgUserRow()] };
    }
    if (/FROM "user" u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE u\.id = \$1/i.test(sql) && /articlecount/i.test(sql)) {
      return { rows: [makePgProfileRow()] };
    }
    if (/articleliked[\s\S]*commentliked/i.test(sql)) {
      return { rows: [makePgLikedRow()] };
    }
    if (/following[\s\S]*follower/i.test(sql)) {
      return { rows: [makePgFollowRow()] };
    }
    if (/FROM "user" u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE p\.email = \$1/i.test(sql)) {
      return { rows: [makePgEmailRow()] };
    }
    throw new Error(`Unexpected PG query: ${sql}`);
  },
});

test('buildUserAuthParityReport verifies all read flows on both engines', async () => {
  const { buildUserAuthParityReport } = loadParityScript();

  const report = await buildUserAuthParityReport(
    buildMySqlStub(),
    buildPgStub(),
    { userId: 1, userName: 'testuser' }
  );

  assert.equal(report.isSuccess, true);
  const flowNames = report.flows.map((f) => f.flow);
  assert.ok(flowNames.includes('checkStatus'));
  assert.ok(flowNames.includes('getUserByName'));
  assert.ok(flowNames.includes('getProfileById'));
  assert.ok(flowNames.includes('getLikedById'));
  assert.ok(flowNames.includes('getFollowInfo'));
  assert.ok(flowNames.includes('findUserByEmail'));
  report.flows.forEach((f) => assert.equal(f.isMatched, true, `Flow ${f.flow} should match`));
});

test('buildUserAuthParityReport detects structureMismatch when profile count differs', async () => {
  const { buildUserAuthParityReport } = loadParityScript();

  const pgPool = {
    async query(sql, params) {
      if (/SELECT status FROM "user"/i.test(sql)) {
        return { rows: [makePgStatusRow()] };
      }
      if (/SELECT \* FROM "user" WHERE name = \$1/i.test(sql)) {
        return { rows: [makePgUserRow()] };
      }
      if (/FROM "user" u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE u\.id = \$1/i.test(sql) && /articlecount/i.test(sql)) {
        return { rows: [makePgProfileRow({ articlecount: '999' })] };
      }
      if (/articleliked[\s\S]*commentliked/i.test(sql)) {
        return { rows: [makePgLikedRow()] };
      }
      if (/following[\s\S]*follower/i.test(sql)) {
        return { rows: [makePgFollowRow()] };
      }
      if (/FROM "user" u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE p\.email = \$1/i.test(sql)) {
        return { rows: [makePgEmailRow()] };
      }
      throw new Error(`Unexpected PG query: ${sql}`);
    },
  };

  const report = await buildUserAuthParityReport(
    buildMySqlStub(),
    pgPool,
    { userId: 1, userName: 'testuser' }
  );

  assert.equal(report.isSuccess, false);
  assert.equal(report.stopConditions.structureMismatch, true);
});

test('formatUserAuthParitySummary produces readable output for passing report', () => {
  const { formatUserAuthParitySummary } = loadParityScript();

  const summary = formatUserAuthParitySummary({
    isSuccess: true,
    userId: 1,
    userName: 'testuser',
    flows: [
      { flow: 'checkStatus', isMatched: true, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false } },
    ],
    stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: false },
  });

  assert.match(summary, /User\/auth parity: PASS/);
  assert.match(summary, /Flows checked: 1/);
});

test('formatUserAuthParitySummary surfaces failing flows', () => {
  const { formatUserAuthParitySummary } = loadParityScript();

  const summary = formatUserAuthParitySummary({
    isSuccess: false,
    userId: 1,
    userName: 'testuser',
    flows: [
      { flow: 'getProfileById', isMatched: false, input: { userId: 1 }, stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: true } },
    ],
    stopConditions: { countMismatch: false, orderMismatch: false, structureMismatch: true },
  });

  assert.match(summary, /User\/auth parity: FAIL/);
  assert.match(summary, /getProfileById/);
  assert.match(summary, /structureMismatch/);
});

test('buildUserAuthParityReport auto-samples user from MySQL when no userId provided', async () => {
  const { buildUserAuthParityReport } = loadParityScript();
  let sampled = false;

  const mysqlPool = {
    async execute(sql, params) {
      if (/FROM user u[\s\S]*INNER JOIN profile/i.test(sql) && /LIMIT 1/i.test(sql)) {
        sampled = true;
        return [[{ userId: 1, userName: 'testuser' }]];
      }
      if (/SELECT status FROM user/i.test(sql)) {
        return [[makeMyStatusRow()]];
      }
      if (/SELECT \* FROM user WHERE name = \?/i.test(sql)) {
        return [[makeMyUserRow()]];
      }
      if (/FROM user u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE u\.id = \?/i.test(sql) && /articleCount/i.test(sql)) {
        return [[makeMyProfileRow()]];
      }
      if (/articleLiked[\s\S]*commentLiked/i.test(sql)) {
        return [[makeMyLikedRow()]];
      }
      if (/following[\s\S]*follower/i.test(sql)) {
        return [[makeMyFollowRow()]];
      }
      if (/SELECT email FROM profile/i.test(sql)) {
        return [[{ email: 'test@example.com' }]];
      }
      if (/FROM user u[\s\S]*LEFT JOIN profile p[\s\S]*WHERE p\.email = \?/i.test(sql)) {
        return [[makeMyEmailRow()]];
      }
      throw new Error(`Unexpected MySQL execute: ${sql}`);
    },
  };

  const report = await buildUserAuthParityReport(mysqlPool, buildPgStub(), {});

  assert.equal(sampled, true, 'Should auto-sample user from MySQL');
  assert.equal(report.isSuccess, true);
});
