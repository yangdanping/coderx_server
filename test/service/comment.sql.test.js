const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/comment.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected comment.sql helper module to exist');
  return require(helperPath);
};

test('buildGetCommentListSql: uses jsonb_build_object and quoted user table', () => {
  const { buildGetCommentListSql } = loadHelper();

  const sql = buildGetCommentListSql({
    sort: 'latest',
    cursorCondition: '',
  });

  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(sql, /LEFT JOIN\s+user\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
});

test('buildGetCommentListSql: oldest keeps ascending order for time pagination', () => {
  const { buildGetCommentListSql } = loadHelper();

  const sql = buildGetCommentListSql({
    sort: 'oldest',
    cursorCondition: 'AND (c.create_at > ? OR (c.create_at = ? AND c.id > ?))',
    direction: 'ASC',
  });

  assert.match(sql, /ORDER BY\s+c\.create_at\s+ASC,\s*c\.id\s+ASC/i);
});

test('buildGetCommentListSql: hot branch keeps pg-safe author JSON and quoted user table', () => {
  const { buildGetCommentListSql } = loadHelper();

  const sql = buildGetCommentListSql({
    sort: 'hot',
    cursorCondition: '',
  });

  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildGetUserCommentListSql: uses LIMIT ? OFFSET ? and quoted user table', () => {
  const { buildGetUserCommentListSql } = loadHelper();

  const sql = buildGetUserCommentListSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(sql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildUserCommentListExecuteParams: orders limit before offset', () => {
  const { buildUserCommentListExecuteParams } = loadHelper();

  assert.deepEqual(buildUserCommentListExecuteParams(9, 20, 10), [9, 10, 20]);
});

test('buildGetReplyPreviewSql: uses jsonb_build_object and quoted user aliases', () => {
  const { buildGetReplyPreviewSql } = loadHelper();

  const sql = buildGetReplyPreviewSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildGetRepliesSql: uses jsonb_build_object and quoted user aliases', () => {
  const { buildGetRepliesSql } = loadHelper();

  const sql = buildGetRepliesSql({
    cursorCondition: '',
  });

  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildGetCommentByIdSql: uses jsonb_build_object and quoted user aliases', () => {
  const { buildGetCommentByIdSql } = loadHelper();

  const sql = buildGetCommentByIdSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildAddCommentSql: appends RETURNING id', () => {
  const { buildAddCommentSql } = loadHelper();

  assert.match(
    buildAddCommentSql(),
    /INSERT INTO comment \(user_id, article_id, content\) VALUES \(\?, \?, \?\) RETURNING id;$/i
  );
});

test('buildAddReplySql: appends RETURNING id for both reply variants', () => {
  const { buildAddReplySql } = loadHelper();

  assert.match(
    buildAddReplySql(false),
    /INSERT INTO comment \(user_id, article_id, comment_id, content\) VALUES \(\?, \?, \?, \?\) RETURNING id;$/i
  );
  assert.match(
    buildAddReplySql(true),
    /INSERT INTO comment \(user_id, article_id, comment_id, reply_id, content\) VALUES \(\?, \?, \?, \?, \?\) RETURNING id;$/i
  );
});
