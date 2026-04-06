const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/comment.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected comment.sql helper module to exist');
  return require(helperPath);
};

test('buildGetCommentListSql: pg uses jsonb_build_object and quoted user table', () => {
  const { buildGetCommentListSql } = loadHelper();

  const pgSql = buildGetCommentListSql('pg', {
    sort: 'latest',
    cursorCondition: '',
  });

  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(pgSql, /LEFT JOIN\s+user\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
});

test('buildGetCommentListSql: oldest keeps ascending order for time pagination', () => {
  const { buildGetCommentListSql } = loadHelper();

  const sql = buildGetCommentListSql('mysql', {
    sort: 'oldest',
    cursorCondition: 'AND (c.create_at > ? OR (c.create_at = ? AND c.id > ?))',
    direction: 'ASC',
  });

  assert.match(sql, /ORDER BY\s+c\.create_at\s+ASC,\s*c\.id\s+ASC/i);
});

test('buildGetCommentListSql: pg hot branch keeps pg-safe author JSON and quoted user table', () => {
  const { buildGetCommentListSql } = loadHelper();

  const pgSql = buildGetCommentListSql('pg', {
    sort: 'hot',
    cursorCondition: '',
  });

  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
});

test('buildGetUserCommentListSql: pg uses LIMIT ? OFFSET ? and quoted user table; mysql keeps LIMIT ?, ?', () => {
  const { buildGetUserCommentListSql } = loadHelper();

  const pgSql = buildGetUserCommentListSql('pg');
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+\?\s*,\s*\?/);

  const mysqlSql = buildGetUserCommentListSql('mysql');
  assert.match(mysqlSql, /JSON_OBJECT\s*\(\s*'id',\s*u\.id/i);
  assert.match(mysqlSql, /LEFT JOIN\s+user\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildUserCommentListExecuteParams: pg orders limit before offset', () => {
  const { buildUserCommentListExecuteParams } = loadHelper();

  assert.deepEqual(buildUserCommentListExecuteParams('mysql', 9, 20, 10), [9, 20, 10]);
  assert.deepEqual(buildUserCommentListExecuteParams('pg', 9, 20, 10), [9, 10, 20]);
});

test('buildGetReplyPreviewSql: pg uses jsonb_build_object and quoted user aliases', () => {
  const { buildGetReplyPreviewSql } = loadHelper();

  const pgSql = buildGetReplyPreviewSql('pg');
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
});

test('buildGetRepliesSql: pg uses jsonb_build_object and quoted user aliases', () => {
  const { buildGetRepliesSql } = loadHelper();

  const pgSql = buildGetRepliesSql('pg', {
    cursorCondition: '',
  });

  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
});

test('buildGetCommentByIdSql: pg uses jsonb_build_object and quoted user aliases', () => {
  const { buildGetCommentByIdSql } = loadHelper();

  const pgSql = buildGetCommentByIdSql('pg');
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*ru\.id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+ru\s+ON\s+ru\.id\s*=\s*rc\.user_id/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
});

test('buildAddCommentSql: pg appends RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddCommentSql } = loadHelper();

  assert.equal(
    buildAddCommentSql('mysql'),
    'INSERT INTO comment (user_id, article_id, content) VALUES (?, ?, ?)'
  );
  assert.match(
    buildAddCommentSql('pg'),
    /INSERT INTO comment \(user_id, article_id, content\) VALUES \(\?, \?, \?\) RETURNING id;$/i
  );
});

test('buildAddReplySql: pg appends RETURNING id for both reply variants', () => {
  const { buildAddReplySql } = loadHelper();

  assert.equal(
    buildAddReplySql('mysql', false),
    'INSERT INTO comment (user_id, article_id, comment_id, content) VALUES (?, ?, ?, ?)'
  );
  assert.equal(
    buildAddReplySql('mysql', true),
    'INSERT INTO comment (user_id, article_id, comment_id, reply_id, content) VALUES (?, ?, ?, ?, ?)'
  );
  assert.match(
    buildAddReplySql('pg', false),
    /INSERT INTO comment \(user_id, article_id, comment_id, content\) VALUES \(\?, \?, \?, \?\) RETURNING id;$/i
  );
  assert.match(
    buildAddReplySql('pg', true),
    /INSERT INTO comment \(user_id, article_id, comment_id, reply_id, content\) VALUES \(\?, \?, \?, \?, \?\) RETURNING id;$/i
  );
});
