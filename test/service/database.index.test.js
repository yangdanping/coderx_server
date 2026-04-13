const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const indexPath = path.resolve(__dirname, '../../src/app/database/index.js');
const configPath = path.resolve(__dirname, '../../src/app/config.js');
const dialectPath = path.resolve(__dirname, '../../src/app/database/dialect.js');
const pgClientPath = path.resolve(__dirname, '../../src/app/database/pg.client.js');

function clearModuleCache() {
  delete require.cache[indexPath];
  delete require.cache[configPath];
  delete require.cache[dialectPath];
  delete require.cache[pgClientPath];
}

test('database index: exports pg client with fixed pg dialect and no dialect resolver dependency', () => {
  const fakeClient = {
    execute() {},
    getConnection() {},
    end() {},
  };

  clearModuleCache();

  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {},
  };

  require.cache[dialectPath] = {
    id: dialectPath,
    filename: dialectPath,
    loaded: true,
    exports: new Proxy(
      {},
      {
        get() {
          throw new Error('dialect module should not be loaded');
        },
      }
    ),
  };

  require.cache[pgClientPath] = {
    id: pgClientPath,
    filename: pgClientPath,
    loaded: true,
    exports: fakeClient,
  };

  const database = require(indexPath);

  assert.equal(database.dialect, 'pg');
  assert.equal(database.execute, fakeClient.execute);
  assert.equal(database.getConnection, fakeClient.getConnection);
  assert.equal(database.end, fakeClient.end);

  clearModuleCache();
});
