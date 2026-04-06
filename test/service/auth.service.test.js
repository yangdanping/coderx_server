const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/auth.service.js');
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

test('checkStatus: pg executes against quoted user table', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ status: 1 }], []];
    },
  });

  const status = await service.checkStatus(7);

  assert.equal(status, 1);
  assert.match(calls[0].statement, /SELECT status FROM "user" WHERE id = \?;/i);
  assert.deepEqual(calls[0].params, [7]);
});
