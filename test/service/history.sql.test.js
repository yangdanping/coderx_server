const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/history.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected history.sql helper to exist');
  return require(helperPath);
};

test('buildAddHistorySql: pg uses ON CONFLICT upsert; mysql keeps ON DUPLICATE KEY', () => {
  const { buildAddHistorySql } = loadHelper();

  const pgSql = buildAddHistorySql('pg');
  assert.match(pgSql, /ON CONFLICT\s*\(\s*user_id\s*,\s*article_id\s*\)\s*DO UPDATE/i);
  assert.doesNotMatch(pgSql, /ON DUPLICATE KEY UPDATE/i);

  const mysqlSql = buildAddHistorySql('mysql');
  assert.match(mysqlSql, /ON DUPLICATE KEY UPDATE/i);
  assert.doesNotMatch(mysqlSql, /ON CONFLICT/i);
});

test('buildGetUserHistorySql: pg uses jsonb_build_object and LIMIT ? OFFSET ?', () => {
  const { buildGetUserHistorySql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';

  const pgSql = buildGetUserHistorySql('pg', base, redirect);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+\?\s*,\s*\?/);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
  assert.doesNotMatch(pgSql, /LEFT JOIN\s+user\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);

  const mysqlSql = buildGetUserHistorySql('mysql', base, redirect);
  assert.match(mysqlSql, /JSON_OBJECT\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(mysqlSql, /jsonb_build_object/i);
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/);
  assert.match(mysqlSql, /LEFT JOIN\s+user\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
});

test('buildUserHistoryExecuteParams: pg orders limit before offset to match LIMIT ? OFFSET ?', () => {
  const { buildUserHistoryExecuteParams } = loadHelper();

  assert.deepEqual(buildUserHistoryExecuteParams('mysql', 9, 20, 10), [9, 20, 10]);
  assert.deepEqual(buildUserHistoryExecuteParams('pg', 9, 20, 10), [9, 10, 20]);
});
