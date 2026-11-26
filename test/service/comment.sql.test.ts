import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAddCommentSql,
  buildAddReplySql,
  buildGetCommentByIdSql,
  buildGetCommentListSql,
  buildGetRepliesSql,
  buildGetReplyPreviewSql,
  buildGetUserCommentListSql,
  buildUserCommentListExecuteParams,
} from '../../src/service/sql/comment.sql.js';

test('buildGetCommentListSql: uses jsonb_build_object and quoted user table', () => {
  const sql = buildGetCommentListSql({
    sort: 'latest',
    cursorCondition: '',
  });

  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /'nickname',\s*p\.nickname/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(sql, /LEFT JOIN\s+user\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
});

test('buildGetCommentListSql: oldest keeps ascending order for time pagination', () => {
  const sql = buildGetCommentListSql({
    sort: 'oldest',
    cursorCondition: 'AND (c.create_at > ? OR (c.create_at = ? AND c.id > ?))',
    direction: 'ASC',
  });

  assert.match(sql, /ORDER BY\s+c\.create_at\s+ASC,\s*c\.id\s+ASC/i);
});

test('buildGetCommentListSql: hot branch keeps pg-safe author JSON and quoted user table', () => {
  const sql = buildGetCommentListSql({
    sort: 'hot',
    cursorCondition: '',
  });

  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildGetUserCommentListSql: uses LIMIT ? OFFSET ? and quoted user table', () => {
  const sql = buildGetUserCommentListSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /ORDER BY\s+c\.create_at\s+DESC,\s*c\.id\s+DESC/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(sql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildUserCommentListExecuteParams: orders limit before offset', () => {
  assert.deepEqual(buildUserCommentListExecuteParams(9, 20, 10), [9, 10, 20]);
});

test('buildGetReplyPreviewSql: uses jsonb_build_object and quoted user aliases', () => {
  const sql = buildGetReplyPreviewSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildGetRepliesSql: uses jsonb_build_object and quoted user aliases', () => {
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
  const sql = buildGetCommentByIdSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
});

test('buildAddCommentSql: appends RETURNING id', () => {
  assert.match(
    buildAddCommentSql(),
    /INSERT INTO comment \(user_id, article_id, content\) VALUES \(\?, \?, \?\) RETURNING id;$/i
  );
});

test('buildAddReplySql: appends RETURNING id for both reply variants', () => {
  assert.match(
    buildAddReplySql(false),
    /INSERT INTO comment \(user_id, article_id, comment_id, content\) VALUES \(\?, \?, \?, \?\) RETURNING id;$/i
  );
  assert.match(
    buildAddReplySql(true),
    /INSERT INTO comment \(user_id, article_id, comment_id, reply_id, content\) VALUES \(\?, \?, \?, \?, \?\) RETURNING id;$/i
  );
});
