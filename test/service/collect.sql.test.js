const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/collect.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected collect.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddCollectSql: pg adds RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddCollectSql } = loadHelper();

  assert.equal(buildAddCollectSql('mysql'), 'INSERT INTO collect (user_id,name) VALUES (?,?);');
  assert.match(buildAddCollectSql('pg'), /INSERT INTO collect \(user_id,name\) VALUES \(\?,\?\) RETURNING id;/i);
});

test('buildGetCollectListSql: pg uses case/jsonb_agg and limit offset pagination', () => {
  const { buildGetCollectListSql } = loadHelper();

  const pgSql = buildGetCollectListSql('pg');
  assert.match(pgSql, /CASE\s+WHEN\s+COUNT\(ac\.article_id\)\s*>\s*0/i);
  assert.match(pgSql, /jsonb_agg\s*\(\s*ac\.article_id\s*\)/i);
  assert.doesNotMatch(pgSql, /\bIF\s*\(/i);
  assert.doesNotMatch(pgSql, /JSON_ARRAYAGG/i);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);

  const mysqlSql = buildGetCollectListSql('mysql');
  assert.match(mysqlSql, /\bIF\s*\(/i);
  assert.match(mysqlSql, /JSON_ARRAYAGG\s*\(\s*ac\.article_id\s*\)/i);
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/i);
});

test('buildGetCollectListExecuteParams: pg orders limit before offset', () => {
  const { buildGetCollectListExecuteParams } = loadHelper();

  assert.deepEqual(buildGetCollectListExecuteParams('mysql', 7, '20', '10'), [7, '20', '10']);
  assert.deepEqual(buildGetCollectListExecuteParams('pg', 7, '20', '10'), [7, '10', '20']);
});

test('buildGetCollectArticleSql: pg uses jsonb_agg while mysql keeps JSON_ARRAYAGG', () => {
  const { buildGetCollectArticleSql } = loadHelper();

  assert.match(buildGetCollectArticleSql('pg'), /jsonb_agg\s*\(\s*ac\.article_id\s*\)\s+collectedArticle/i);
  assert.match(buildGetCollectArticleSql('mysql'), /JSON_ARRAYAGG\s*\(\s*ac\.article_id\s*\)\s+collectedArticle/i);
});
