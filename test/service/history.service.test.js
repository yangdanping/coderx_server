const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/history.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[urlsPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  require.cache[urlsPath] = {
    id: urlsPath,
    filename: urlsPath,
    loaded: true,
    exports: {
      baseURL: 'https://api.example',
      redirectURL: 'https://app.example',
    },
  };

  return require(servicePath);
}

test('addHistory: pg executes ON CONFLICT upsert SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ affectedRows: 1 }, []];
    },
  });

  const result = await service.addHistory(9, 12);

  assert.deepEqual(result, { affectedRows: 1 });
  assert.match(calls[0].statement, /ON CONFLICT\s*\(\s*user_id\s*,\s*article_id\s*\)\s*DO UPDATE/i);
  assert.doesNotMatch(calls[0].statement, /ON DUPLICATE KEY UPDATE/i);
  assert.deepEqual(calls[0].params, [9, 12]);
});

test('getUserHistory: pg uses limit-first params and pg-safe author SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, articleId: 12, title: 'hello' }], []];
    },
  });

  const result = await service.getUserHistory(9, '20', '10');

  assert.deepEqual(result, [{ id: 1, articleId: 12, title: 'hello' }]);
  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.deepEqual(calls[0].params, [9, '10', '20']);
});
