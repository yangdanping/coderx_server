import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGetArticleByCollectIdExecuteParams,
  buildGetArticleByCollectIdSql,
  buildGetCommentByIdExecuteParams,
  buildGetCommentByIdSql,
  buildGetFollowInfoSql,
  buildGetHotUsersSql,
  buildGetLikedByIdSql,
  buildGetProfileByIdSql,
  buildGetUserByNameSql,
} from '../../src/service/sql/user.sql.js';

test('buildGetUserByNameSql: quotes reserved user table', () => {
  const sql = buildGetUserByNameSql();
  assert.match(sql, /FROM\s+"user"\s+WHERE\s+name\s*=\s*\?/i);
});

test('buildGetProfileByIdSql: quotes reserved user table and returns nickname with account name', () => {
  const sql = buildGetProfileByIdSql();
  assert.match(sql, /FROM\s+"user"\s+u/i);
  assert.doesNotMatch(sql, /FROM\s+user\s+u/i);
  assert.match(sql, /u\.name/i);
  assert.match(sql, /p\.nickname/i);
});

test('buildGetCommentByIdSql: uses jsonb_build_object, quoted user table, and limit offset pagination', () => {
  const sql = buildGetCommentByIdSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /'nickname',\s*p\.nickname/i);
  assert.match(sql, /jsonb_build_object[\s\S]*?AS\s+"user"/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(sql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildGetCommentByIdExecuteParams: orders limit before offset', () => {
  assert.deepEqual(buildGetCommentByIdExecuteParams(9, '20', '10'), [9, '10', '20']);
});

test('buildGetLikedByIdSql: uses jsonb_agg and quoted user table', () => {
  const sql = buildGetLikedByIdSql();
  assert.match(sql, /jsonb_agg\s*\(/i);
  assert.doesNotMatch(sql, /JSON_ARRAYAGG/i);
  assert.match(sql, /FROM\s+"user"\s+u/i);
});

test('buildGetFollowInfoSql: uses case when, jsonb builders, and quoted user table', () => {
  const sql = buildGetFollowInfoSql();
  assert.match(sql, /CASE\s+WHEN/i);
  assert.doesNotMatch(sql, /\bIF\s*\(/i);
  assert.match(sql, /jsonb_agg\s*\(/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id'/i);
  assert.match(sql, /'nickname',\s*fp\.nickname/i);
  assert.match(sql, /'nickname',\s*pf\.nickname/i);
  assert.match(sql, /FROM\s+"user"\s+u/i);
});

test('buildGetArticleByCollectIdSql: uses limit offset pagination', () => {
  const sql = buildGetArticleByCollectIdSql();
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(sql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildGetArticleByCollectIdExecuteParams: orders limit before offset', () => {
  assert.deepEqual(buildGetArticleByCollectIdExecuteParams(9, 3, '20', '10'), [9, 3, '10', '20']);
});

test('buildGetHotUsersSql: uses jsonb_build_object, quoted user table, and fixed limit syntax', () => {
  const sql = buildGetHotUsersSql();
  assert.match(sql, /jsonb_build_object\s*\(\s*'totalLikes'/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.match(sql, /FROM\s+"user"\s+u/i);
  assert.match(sql, /p\.nickname/i);
  assert.match(sql, /LIMIT\s+5\b/i);
  assert.doesNotMatch(sql, /LIMIT\s+0\s*,\s*5/i);
});
