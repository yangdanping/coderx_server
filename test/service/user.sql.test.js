const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/user.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected user.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildGetUserByNameSql: pg quotes reserved user table and mysql keeps legacy SQL', () => {
  const { buildGetUserByNameSql } = loadHelper();

  const pgSql = buildGetUserByNameSql('pg');
  assert.match(pgSql, /FROM\s+"user"\s+WHERE\s+name\s*=\s*\?/i);

  const mysqlSql = buildGetUserByNameSql('mysql');
  assert.equal(mysqlSql, 'SELECT * FROM user WHERE name = ?;');
});

test('buildGetProfileByIdSql: pg quotes reserved user table', () => {
  const { buildGetProfileByIdSql } = loadHelper();

  const pgSql = buildGetProfileByIdSql('pg');
  assert.match(pgSql, /FROM\s+"user"\s+u/i);
  assert.doesNotMatch(pgSql, /FROM\s+user\s+u/i);
});

test('buildGetCommentByIdSql: pg uses jsonb_build_object, quoted user table, and limit offset pagination', () => {
  const { buildGetCommentByIdSql } = loadHelper();

  const pgSql = buildGetCommentByIdSql('pg');
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /jsonb_build_object[\s\S]*?AS\s+"user"/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+\?\s*,\s*\?/);

  const mysqlSql = buildGetCommentByIdSql('mysql');
  assert.match(mysqlSql, /JSON_OBJECT\s*\(\s*'id',\s*u\.id/i);
  assert.match(mysqlSql, /LEFT JOIN\s+user\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildGetCommentByIdExecuteParams: pg orders limit before offset', () => {
  const { buildGetCommentByIdExecuteParams } = loadHelper();

  assert.deepEqual(buildGetCommentByIdExecuteParams('mysql', 9, '20', '10'), [9, '20', '10']);
  assert.deepEqual(buildGetCommentByIdExecuteParams('pg', 9, '20', '10'), [9, '10', '20']);
});

test('buildGetLikedByIdSql: pg uses jsonb_agg and quoted user table', () => {
  const { buildGetLikedByIdSql } = loadHelper();

  const pgSql = buildGetLikedByIdSql('pg');
  assert.match(pgSql, /jsonb_agg\s*\(/i);
  assert.doesNotMatch(pgSql, /JSON_ARRAYAGG/i);
  assert.match(pgSql, /FROM\s+"user"\s+u/i);
});

test('buildGetFollowInfoSql: pg uses case when, jsonb builders, and quoted user table', () => {
  const { buildGetFollowInfoSql } = loadHelper();

  const pgSql = buildGetFollowInfoSql('pg');
  assert.match(pgSql, /CASE\s+WHEN/i);
  assert.doesNotMatch(pgSql, /\bIF\s*\(/i);
  assert.match(pgSql, /jsonb_agg\s*\(/i);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id'/i);
  assert.match(pgSql, /FROM\s+"user"\s+u/i);
});

test('buildGetArticleByCollectIdSql: pg uses limit offset pagination while mysql keeps limit comma syntax', () => {
  const { buildGetArticleByCollectIdSql } = loadHelper();

  const pgSql = buildGetArticleByCollectIdSql('pg');
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+\?\s*,\s*\?/);

  const mysqlSql = buildGetArticleByCollectIdSql('mysql');
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildGetArticleByCollectIdExecuteParams: pg orders limit before offset', () => {
  const { buildGetArticleByCollectIdExecuteParams } = loadHelper();

  assert.deepEqual(buildGetArticleByCollectIdExecuteParams('mysql', 9, 3, '20', '10'), [9, 3, '20', '10']);
  assert.deepEqual(buildGetArticleByCollectIdExecuteParams('pg', 9, 3, '20', '10'), [9, 3, '10', '20']);
});

test('buildGetHotUsersSql: pg uses jsonb_build_object, quoted user table, and fixed limit syntax', () => {
  const { buildGetHotUsersSql } = loadHelper();

  const pgSql = buildGetHotUsersSql('pg');
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'totalLikes'/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
  assert.match(pgSql, /FROM\s+"user"\s+u/i);
  assert.match(pgSql, /LIMIT\s+5\b/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+0\s*,\s*5/i);
});
