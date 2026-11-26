import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAddCollectSql, buildGetCollectArticleSql, buildGetCollectListExecuteParams, buildGetCollectListSql } from '../../src/service/sql/collect.sql.js';

test('buildAddCollectSql: adds RETURNING id', () => {
  assert.match(buildAddCollectSql(), /INSERT INTO collect \(user_id,name\) VALUES \(\?,\?\) RETURNING id;/i);
});

test('buildGetCollectListSql: uses case/jsonb_agg and limit offset pagination', () => {
  const sql = buildGetCollectListSql();
  assert.match(sql, /CASE\s+WHEN\s+COUNT\(ac\.article_id\)\s*>\s*0/i);
  assert.match(sql, /jsonb_agg\s*\(\s*ac\.article_id\s*\)/i);
  assert.doesNotMatch(sql, /\bIF\s*\(/i);
  assert.doesNotMatch(sql, /JSON_ARRAYAGG/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
});

test('buildGetCollectListExecuteParams: orders limit before offset', () => {
  assert.deepEqual(buildGetCollectListExecuteParams(7, '20', '10'), [7, '10', '20']);
});

test('buildGetCollectArticleSql: uses jsonb_agg', () => {
  assert.match(buildGetCollectArticleSql(), /jsonb_agg\s*\(\s*ac\.article_id\s*\)\s+AS\s+"collectedArticle"/i);
});
