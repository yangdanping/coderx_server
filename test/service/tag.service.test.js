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
    assert.match(calls[0].statement, /SELECT \* FROM tag LIMIT \? OFFSET \?;/i);
    assert.deepEqual(calls[0].params, ['10', '20']);
    assert.deepEqual(consoleCalls, []);
  } finally {
    console.log = originalConsoleLog;
  }
});
