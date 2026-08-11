const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/012_create_flow_post.sql'), 'utf8');
const flowSql = require('../../src/service/sql/flow.sql');

test('flow migration creates ordered unique media ownership and feed indexes', () => {
  assert.match(migration, /CREATE TABLE flow_post/i);
  assert.match(migration, /UNIQUE \(user_id, client_request_id\)/i);
  assert.match(migration, /CREATE TABLE flow_post_media/i);
  assert.match(migration, /file_id BIGINT NOT NULL UNIQUE/i);
  assert.match(migration, /UNIQUE \(flow_id, position\)/i);
  assert.match(migration, /position BETWEEN 0 AND 8/i);
});

test('flow SQL locks requested image rows for ownership validation', () => {
  const sql = flowSql.buildLockFlowMediaSql(2);
  assert.match(sql, /FROM file f/i);
  assert.match(sql, /LEFT JOIN flow_post_media/i);
  assert.match(sql, /FOR UPDATE OF f/i);
  assert.equal((sql.match(/\?/g) || []).length, 3);
});

test('flow SQL builders create posts, ordered media, and read queries', () => {
  assert.match(flowSql.buildInsertFlowSql(), /INSERT INTO flow_post/i);
  assert.match(flowSql.buildInsertFlowSql(), /RETURNING id/i);
  assert.equal((flowSql.buildInsertFlowSql().match(/\?/g) || []).length, 4);

  assert.equal((flowSql.buildInsertFlowMediaSql(2).match(/\?/g) || []).length, 8);
  assert.equal(flowSql.buildInsertFlowMediaSql(0), null);

  assert.match(flowSql.buildFlowFeedSql(), /FROM flow_post fp/i);
  assert.match(flowSql.buildFlowFeedSql(), /ORDER BY fp\.create_at DESC, fp\.id DESC/i);
  assert.match(flowSql.buildFlowDetailSql(), /WHERE fp\.id = \?/i);
});
