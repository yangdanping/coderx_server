const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/collect.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected collect.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddCollectSql: adds RETURNING id', () => {
  const { buildAddCollectSql } = loadHelper();

  assert.match(buildAddCollectSql(), /INSERT INTO collect \(user_id,name\) VALUES \(\?,\?\) RETURNING id;/i);
});

test('buildGetCollectListSql: uses case/jsonb_agg and limit offset pagination', () => {
  const { buildGetCollectListSql } = loadHelper();

  const sql = buildGetCollectListSql();
  assert.match(sql, /CASE\s+WHEN\s+COUNT\(ac\.article_id\)\s*>\s*0/i);
  assert.match(sql, /jsonb_agg\s*\(\s*ac\.article_id\s*\)/i);
  assert.doesNotMatch(sql, /\bIF\s*\(/i);
  assert.doesNotMatch(sql, /JSON_ARRAYAGG/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
});

test('buildGetCollectListExecuteParams: orders limit before offset', () => {
  const { buildGetCollectListExecuteParams } = loadHelper();

  assert.deepEqual(buildGetCollectListExecuteParams(7, '20', '10'), [7, '10', '20']);
});

test('buildGetCollectArticleSql: uses jsonb_agg', () => {
  const { buildGetCollectArticleSql } = loadHelper();

  assert.match(buildGetCollectArticleSql(), /jsonb_agg\s*\(\s*ac\.article_id\s*\)\s+AS\s+"collectedArticle"/i);
});
