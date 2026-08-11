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

test('flow SQL locks bare requested file rows before a fresh ownership and association validation', () => {
  const sql = flowSql.buildLockFlowMediaSql(2);
  assert.match(sql, /SELECT\s+f\.id/is);
  assert.match(sql, /FROM file f/i);
  assert.match(sql, /WHERE\s+f\.id IN \(\?,\?\)/i);
  assert.match(sql, /FOR UPDATE OF f/i);
  assert.doesNotMatch(sql, /JOIN flow_post_media/i);
  assert.doesNotMatch(sql, /user_id/i);
  assert.equal((sql.match(/\?/g) || []).length, 2);

  const validationSql = flowSql.buildValidateFlowMediaSql(2);
  assert.match(validationSql, /INNER JOIN image_meta im ON im\.file_id = f\.id/i);
  assert.match(validationSql, /f\.user_id = \?/i);
  assert.match(validationSql, /\(f\.draft_id IS NULL OR f\.draft_id = \?\)/i);
  assert.match(validationSql, /NOT EXISTS[\s\S]*FROM flow_post_media fm[\s\S]*fm\.file_id = f\.id/i);
  assert.match(validationSql, /f\.mimetype = 'image\/webp'/i);
  assert.match(validationSql, /f\.filename ~/i);
  assert.match(validationSql, /im\.width BETWEEN 1 AND 2560/i);
  assert.match(validationSql, /im\.height BETWEEN 1 AND 2560/i);
  assert.equal((validationSql.match(/\?/g) || []).length, 4);
});

test('flow SQL locks the exact active Flow draft before files and clears only its submitted bindings', () => {
  assert.match(flowSql.buildLockActiveFlowDraftSql(), /FROM draft[\s\S]*user_id = \?[\s\S]*draft_type = 'flow'[\s\S]*status = 'active'[\s\S]*FOR UPDATE/i);
  const clearSql = flowSql.buildClearFlowDraftMediaSql(2);
  assert.match(clearSql, /UPDATE file[\s\S]*SET draft_id = NULL/i);
  assert.match(clearSql, /draft_id = \?/i);
  assert.match(clearSql, /id IN \(\?,\?\)/i);
  assert.equal((clearSql.match(/\?/g) || []).length, 3);
});

test('flow SQL builders create posts, ordered media, and read queries', () => {
  assert.match(flowSql.buildInsertFlowSql(), /INSERT INTO flow_post/i);
  assert.match(flowSql.buildInsertFlowSql(), /ON CONFLICT \(user_id, client_request_id\) DO NOTHING RETURNING id/i);
  assert.equal((flowSql.buildInsertFlowSql().match(/\?/g) || []).length, 4);

  assert.match(flowSql.buildInsertFlowMediaSql(2), /INSERT INTO flow_post_media \(flow_id, file_id, position\)/i);
  assert.equal((flowSql.buildInsertFlowMediaSql(2).match(/\?/g) || []).length, 6);
  assert.equal(flowSql.buildInsertFlowMediaSql(0), null);

  assert.match(flowSql.buildFlowFeedSql(), /FROM flow_post fp/i);
  assert.match(flowSql.buildFlowFeedSql(), /ORDER BY fp\.create_at DESC, fp\.id DESC/i);
  assert.match(flowSql.buildFlowDetailSql(), /WHERE fp\.id = \?/i);
});

test('flow SQL finds an idempotent create result by user and client request', () => {
  assert.match(flowSql.buildFindFlowByRequestIdSql(), /FROM flow_post/i);
  assert.match(flowSql.buildFindFlowByRequestIdSql(), /WHERE user_id = \? AND client_request_id = \?/i);
  assert.equal((flowSql.buildFindFlowByRequestIdSql().match(/\?/g) || []).length, 2);
});
