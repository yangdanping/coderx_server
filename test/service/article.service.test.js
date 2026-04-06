const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/article.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');
const utilsPath = path.resolve(__dirname, '../../src/utils/index.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[urlsPath];
  delete require.cache[utilsPath];

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

  require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    exports: {},
  };

  return require(servicePath);
}

test('addArticle: pg requests insertId through RETURNING id', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ insertId: /RETURNING\s+id/i.test(statement) ? 301 : 0, affectedRows: 1 }, []];
    },
  });

  const result = await service.addArticle(9, 'Title', '<p>Content</p>');

  assert.equal(result.insertId, 301);
  assert.match(calls[0].statement, /INSERT INTO article \(user_id,title, content\) VALUES \(\?,\?,\?\) RETURNING id;$/i);
  assert.deepEqual(calls[0].params, [9, 'Title', '<p>Content</p>']);
});
