const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/auth.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected auth.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildCheckStatusSql: uses quoted reserved user table', () => {
  const { buildCheckStatusSql } = loadHelper();

  assert.equal(buildCheckStatusSql(), 'SELECT status FROM "user" WHERE id = ?;');
});
