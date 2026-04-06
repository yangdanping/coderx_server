const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/tag.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected tag.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddTagSql: pg adds RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddTagSql } = loadHelper();

  assert.equal(buildAddTagSql('mysql'), 'INSERT INTO tag (name) VALUES (?);');
  assert.match(buildAddTagSql('pg'), /INSERT INTO tag \(name\) VALUES \(\?\) RETURNING id;/i);
});

test('buildGetTagListSql: pg uses limit offset pagination while mysql keeps limit comma syntax', () => {
  const { buildGetTagListSql } = loadHelper();

  assert.match(buildGetTagListSql('pg'), /SELECT \* FROM tag LIMIT \? OFFSET \?;/i);
  assert.match(buildGetTagListSql('mysql'), /SELECT \* FROM tag LIMIT \?,\?;/i);
});

test('buildGetTagListExecuteParams: pg orders limit before offset', () => {
  const { buildGetTagListExecuteParams } = loadHelper();

  assert.deepEqual(buildGetTagListExecuteParams('mysql', '20', '10'), ['20', '10']);
  assert.deepEqual(buildGetTagListExecuteParams('pg', '20', '10'), ['10', '20']);
});
