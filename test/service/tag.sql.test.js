const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/tag.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected tag.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddTagSql: adds RETURNING id', () => {
  const { buildAddTagSql } = loadHelper();

  assert.match(buildAddTagSql(), /INSERT INTO tag \(name\) VALUES \(\?\) RETURNING id;/i);
});

test('buildGetTagListSql: uses limit offset pagination', () => {
  const { buildGetTagListSql } = loadHelper();

  assert.match(buildGetTagListSql(), /SELECT \* FROM tag LIMIT \? OFFSET \?;/i);
});

test('buildGetTagListExecuteParams: orders limit before offset', () => {
  const { buildGetTagListExecuteParams } = loadHelper();

  assert.deepEqual(buildGetTagListExecuteParams('20', '10'), ['10', '20']);
});
