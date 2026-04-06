const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/auth.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected auth.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildCheckStatusSql: pg quotes reserved user table while mysql keeps legacy SQL', () => {
  const { buildCheckStatusSql } = loadHelper();

  assert.equal(buildCheckStatusSql('mysql'), 'SELECT status FROM user WHERE id = ?;');
  assert.match(buildCheckStatusSql('pg'), /SELECT status FROM "user" WHERE id = \?;/i);
});
