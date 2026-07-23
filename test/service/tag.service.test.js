const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/tag.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  return require(servicePath);
}

test('addTag: pg requests insertId through RETURNING id', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ insertId: /RETURNING\s+id/i.test(statement) ? 21 : 0, affectedRows: 1 }, []];
    },
  });

  const result = await service.addTag('postgres');

  assert.equal(result.insertId, 21);
  assert.match(calls[0].statement, /INSERT INTO tag \(name\) VALUES \(\?\) RETURNING id;/i);
  assert.deepEqual(calls[0].params, ['postgres']);
});

test('getTagList: pg uses limit-first params and pg-safe pagination SQL', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const consoleCalls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, name: 'node' }], []];
    },
  });

  console.log = (...args) => {
    consoleCalls.push(args);
  };

  try {
    const result = await service.getTagList('20', '10');

    assert.deepEqual(result, [{ id: 1, name: 'node' }]);
    assert.match(calls[0].statement, /SELECT \* FROM tag ORDER BY id ASC LIMIT \? OFFSET \?;/i);
    assert.deepEqual(calls[0].params, ['10', '20']);
    assert.deepEqual(consoleCalls, []);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('getUserTagOrder: reads the current user ordered list', async () => {
  const calls = [];
  const expected = [
    { id: 3, name: 'JS/TS' },
    { id: 1, name: '前端' },
  ];
  const service = loadServiceWithConnection({
    async execute(statement, params) {
      calls.push({ statement, params });
      return [expected, []];
    },
  });

  const result = await service.getUserTagOrder(7);

  assert.deepEqual(result, expected);
  assert.match(calls[0].statement, /LEFT JOIN user_tag_preference/i);
  assert.match(
    calls[0].statement,
    /ORDER BY\s+utp\.sort_order ASC NULLS LAST,[\s\S]*CASE\s+WHEN utp\.sort_order IS NULL AND t\.name = '人工智能'\s+THEN 0\s+ELSE 1\s+END ASC,[\s\S]*t\.id ASC;/i,
  );
  assert.deepEqual(calls[0].params, [7]);
});

test('replaceUserTagOrder: rejects duplicate and invalid tag ids before opening a transaction', async () => {
  let connectionRequested = false;
  const service = loadServiceWithConnection({
    async getConnection() {
      connectionRequested = true;
      throw new Error('must not open transaction');
    },
  });

  await assert.rejects(() => service.replaceUserTagOrder(7, [1, 1]), /标签顺序不能包含重复项/);
  await assert.rejects(() => service.replaceUserTagOrder(7, [1, 0]), /标签 ID 必须是正整数/);
  await assert.rejects(() => service.replaceUserTagOrder(7, '1,2'), /标签顺序必须是数组/);
  assert.equal(connectionRequested, false);
});

test('replaceUserTagOrder: atomically replaces rows and returns normalized order', async () => {
  const calls = [];
  const normalized = [
    { id: 3, name: 'JS/TS' },
    { id: 1, name: '前端' },
  ];
  const transaction = {
    async beginTransaction() {
      calls.push({ method: 'begin' });
    },
    async execute(statement, params) {
      calls.push({ method: 'execute', statement, params });
      if (/SELECT id FROM tag WHERE id IN/i.test(statement)) {
        return [[{ id: 1 }, { id: 3 }], []];
      }
      if (/SELECT t\.id, t\.name/i.test(statement)) {
        return [normalized, []];
      }
      return [{ affectedRows: 2 }, []];
    },
    async commit() {
      calls.push({ method: 'commit' });
    },
    async rollback() {
      calls.push({ method: 'rollback' });
    },
    release() {
      calls.push({ method: 'release' });
    },
  };
  const service = loadServiceWithConnection({
    async getConnection() {
      calls.push({ method: 'getConnection' });
      return transaction;
    },
  });

  const result = await service.replaceUserTagOrder(7, [3, 1]);

  assert.deepEqual(result, normalized);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['getConnection', 'begin', 'execute', 'execute', 'execute', 'execute', 'commit', 'release'],
  );
  assert.deepEqual(calls[2].params, [3, 1]);
  assert.match(calls[3].statement, /DELETE FROM user_tag_preference WHERE user_id = \?/i);
  assert.deepEqual(calls[3].params, [7]);
  assert.match(calls[4].statement, /INSERT INTO user_tag_preference/i);
  assert.deepEqual(calls[4].params, [7, 3, 0, 7, 1, 1]);
  assert.deepEqual(calls[5].params, [7]);
});

test('replaceUserTagOrder: clears preferences when the submitted order is empty', async () => {
  const statements = [];
  const transaction = {
    async beginTransaction() {},
    async execute(statement, params) {
      statements.push({ statement, params });
      if (/SELECT t\.id, t\.name/i.test(statement)) return [[{ id: 1, name: '前端' }], []];
      return [{ affectedRows: 1 }, []];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const service = loadServiceWithConnection({
    async getConnection() {
      return transaction;
    },
  });

  const result = await service.replaceUserTagOrder(7, []);

  assert.deepEqual(result, [{ id: 1, name: '前端' }]);
  assert.equal(
    statements.some(({ statement }) => /INSERT INTO user_tag_preference/i.test(statement)),
    false,
  );
  assert.match(statements[0].statement, /DELETE FROM user_tag_preference/i);
});

test('replaceUserTagOrder: rolls back when a requested tag does not exist', async () => {
  const events = [];
  const transaction = {
    async beginTransaction() {
      events.push('begin');
    },
    async execute(statement) {
      events.push('execute');
      if (/SELECT id FROM tag/i.test(statement)) return [[{ id: 1 }], []];
      throw new Error('unexpected write');
    },
    async commit() {
      events.push('commit');
    },
    async rollback() {
      events.push('rollback');
    },
    release() {
      events.push('release');
    },
  };
  const service = loadServiceWithConnection({
    async getConnection() {
      return transaction;
    },
  });

  await assert.rejects(() => service.replaceUserTagOrder(7, [1, 999]), /标签不存在/);
  assert.deepEqual(events, ['begin', 'execute', 'rollback', 'release']);
});

test('replaceUserTagOrder: rolls back and releases when persistence fails', async () => {
  const events = [];
  const transaction = {
    async beginTransaction() {
      events.push('begin');
    },
    async execute(statement) {
      if (/SELECT id FROM tag/i.test(statement)) return [[{ id: 1 }, { id: 2 }], []];
      if (/DELETE FROM user_tag_preference/i.test(statement)) return [{ affectedRows: 2 }, []];
      if (/INSERT INTO user_tag_preference/i.test(statement)) throw new Error('insert failed');
      throw new Error('unexpected query');
    },
    async commit() {
      events.push('commit');
    },
    async rollback() {
      events.push('rollback');
    },
    release() {
      events.push('release');
    },
  };
  const service = loadServiceWithConnection({
    async getConnection() {
      return transaction;
    },
  });

  await assert.rejects(() => service.replaceUserTagOrder(7, [1, 2]), /insert failed/);
  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});
