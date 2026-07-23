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

test('buildGetTagListSql: uses deterministic id order before pagination', () => {
  const { buildGetTagListSql } = loadHelper();

  assert.match(buildGetTagListSql(), /SELECT \* FROM tag ORDER BY id ASC LIMIT \? OFFSET \?;/i);
});

test('buildGetTagListExecuteParams: orders limit before offset', () => {
  const { buildGetTagListExecuteParams } = loadHelper();

  assert.deepEqual(buildGetTagListExecuteParams('20', '10'), ['10', '20']);
});

test('buildGetUserTagOrderSql: keeps saved order and defaults unranked AI first', () => {
  const { buildGetUserTagOrderSql } = loadHelper();
  const statement = buildGetUserTagOrderSql();

  assert.match(statement, /FROM tag t/i);
  assert.match(statement, /LEFT JOIN user_tag_preference utp/i);
  assert.match(statement, /utp\.user_id = \?/i);
  assert.match(
    statement,
    /ORDER BY\s+utp\.sort_order ASC NULLS LAST,[\s\S]*CASE\s+WHEN utp\.sort_order IS NULL AND t\.name = '人工智能'\s+THEN 0\s+ELSE 1\s+END ASC,[\s\S]*t\.id ASC;/i,
  );
});

test('buildDeleteUserTagOrderSql: scopes replacement to one user', () => {
  const { buildDeleteUserTagOrderSql } = loadHelper();

  assert.match(buildDeleteUserTagOrderSql(), /DELETE FROM user_tag_preference WHERE user_id = \?;/i);
});

test('buildInsertUserTagOrderSql: builds one parameterized row per tag', () => {
  const { buildInsertUserTagOrderSql } = loadHelper();

  assert.equal(buildInsertUserTagOrderSql(3), 'INSERT INTO user_tag_preference (user_id, tag_id, sort_order) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?);');
  assert.equal(buildInsertUserTagOrderSql(0), null);
});

test('buildGetExistingTagIdsSql: validates all requested ids in one query', () => {
  const { buildGetExistingTagIdsSql } = loadHelper();

  assert.equal(buildGetExistingTagIdsSql(3), 'SELECT id FROM tag WHERE id IN (?, ?, ?);');
  assert.equal(buildGetExistingTagIdsSql(0), null);
});
