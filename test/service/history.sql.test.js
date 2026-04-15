const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/history.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected history.sql helper to exist');
  return require(helperPath);
};

test('buildAddHistorySql: uses ON CONFLICT upsert', () => {
  const { buildAddHistorySql } = loadHelper();

  const sql = buildAddHistorySql();
  assert.match(sql, /ON CONFLICT\s*\(\s*user_id\s*,\s*article_id\s*\)\s*DO UPDATE/i);
  assert.doesNotMatch(sql, /ON DUPLICATE KEY UPDATE/i);
});

test('buildGetUserHistorySql: uses jsonb_build_object and LIMIT ? OFFSET ?', () => {
  const { buildGetUserHistorySql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';

  const sql = buildGetUserHistorySql(base, redirect);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /a\.excerpt\s+AS\s+"excerpt"/i);
  assert.doesNotMatch(sql, /\ba\.content\b/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(sql, /LIMIT\s+\?\s*,\s*\?/);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
  assert.doesNotMatch(sql, /LEFT JOIN\s+user\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
});

test('buildUserHistoryExecuteParams: orders limit before offset to match LIMIT ? OFFSET ?', () => {
  const { buildUserHistoryExecuteParams } = loadHelper();

  assert.deepEqual(buildUserHistoryExecuteParams(9, 20, 10), [9, 10, 20]);
});
