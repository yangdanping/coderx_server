const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/collect.service.js');
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

test('addCollect: pg requests insertId through RETURNING id', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ insertId: /RETURNING\s+id/i.test(statement) ? 15 : 0, affectedRows: 1 }, []];
    },
  });

  const result = await service.addCollect(3, 'favorites');

  assert.equal(result.insertId, 15);
  assert.match(calls[0].statement, /INSERT INTO collect \(user_id,name\) VALUES \(\?,\?\) RETURNING id;/i);
  assert.deepEqual(calls[0].params, [3, 'favorites']);
});

test('getCollectList: pg uses limit-first params and pg-safe aggregate SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, count: [11, 12] }], []];
    },
  });

  const result = await service.getCollectList(9, '20', '10');

  assert.deepEqual(result, [{ id: 1, count: [11, 12] }]);
  assert.match(calls[0].statement, /jsonb_agg\s*\(\s*ac\.article_id\s*\)/i);
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.deepEqual(calls[0].params, [9, '10', '20']);
});
