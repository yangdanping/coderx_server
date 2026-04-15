const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/article.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected article.sql helper module to exist');
  return require(helperPath);
};

test('buildGetArticleByIdSql: uses jsonb_build_object/jsonb_agg and quoted user table', () => {
  const { buildGetArticleByIdSql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';

  const sql = buildGetArticleByIdSql(base, redirect);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_agg\s*\(\s*jsonb_build_object/i);
  assert.match(sql, /a\.create_at\s+AS\s+"createAt"/i);
  assert.match(sql, /a\.update_at\s+AS\s+"updateAt"/i);
  assert.match(sql, /a\.content\s+AS\s+"contentJson"/i);
  assert.match(sql, /a\.excerpt\s+AS\s+"excerpt"/i);
  assert.doesNotMatch(sql, /a\.content_html\s+AS\s+"contentHtml"/i);
  assert.doesNotMatch(sql, /a\.content_json\s+AS\s+"contentJson"/i);
  assert.doesNotMatch(sql, /COALESCE\(a\.content_html,\s*a\.content\)\s+AS\s+"contentHtml"/i);
  assert.match(sql, /\)\s+AS\s+"commentCount"/i);
  assert.match(sql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
  assert.doesNotMatch(sql, /JSON_OBJECT/i);
  assert.doesNotMatch(sql, /JSON_ARRAYAGG/i);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
  assert.doesNotMatch(sql, /LEFT JOIN\s+user\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
});

test('buildGetArticleListSql: uses optimized-style shape (no GROUP BY), jsonb_*, LIMIT ? OFFSET ?', () => {
  const { buildGetArticleListSql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';

  const sql = buildGetArticleListSql(base, redirect, {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.doesNotMatch(sql, /\bGROUP BY\s+a\.id\b/i);
  assert.match(sql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(sql, /jsonb_agg\s*\(\s*jsonb_build_object/i);
  assert.match(sql, /a\.create_at\s+AS\s+"createAt"/i);
  assert.match(sql, /a\.update_at\s+AS\s+"updateAt"/i);
  assert.match(sql, /a\.excerpt\s+AS\s+"excerpt"/i);
  assert.doesNotMatch(sql, /a\.content\s*,/i);
  assert.match(sql, /COALESCE\(comment_agg\.commentCount,\s*0\)\s+AS\s+"commentCount"/i);
  assert.match(sql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(sql, /LIMIT\s+\?\s*,\s*\?/);
  assert.match(sql, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
});

test('buildGetArticleListOptimizedSql: matches list SQL output', () => {
  const { buildGetArticleListOptimizedSql, buildGetArticleListSql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';
  const opts = { tagId: '', userId: '', idList: [], keywords: '', pageOrder: 'date' };

  const a = buildGetArticleListOptimizedSql(base, redirect, opts);
  const b = buildGetArticleListSql(base, redirect, opts);
  assert.equal(a.replace(/\s+/g, ' ').trim(), b.replace(/\s+/g, ' ').trim());
});

test('buildArticleListExecuteParams: orders limit before offset', () => {
  const { buildArticleListExecuteParams } = loadHelper();
  assert.deepEqual(buildArticleListExecuteParams([1, 2], 20, 10), [1, 2, 10, 20]);
});

test('buildGetArticlesByKeyWordsSql: uses LIMIT ? OFFSET ?', () => {
  const { buildGetArticlesByKeyWordsSql } = loadHelper();
  const redirect = 'https://app.example';

  const sql = buildGetArticlesByKeyWordsSql(redirect);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.match(sql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
  assert.doesNotMatch(sql, /LIMIT\s+0\s*,\s*10/i);
});

test('buildGetArticlesByKeyWordsExecuteParams: appends limit and offset after pattern', () => {
  const { buildGetArticlesByKeyWordsExecuteParams } = loadHelper();
  assert.deepEqual(buildGetArticlesByKeyWordsExecuteParams('kw'), ['%kw%', 10, 0]);
});

test('buildGetRecommendArticleListSql: uses LIMIT ? OFFSET ?', () => {
  const { buildGetRecommendArticleListSql } = loadHelper();
  const redirect = 'https://app.example';

  const sql = buildGetRecommendArticleListSql(redirect);
  assert.match(sql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.match(sql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
});

test('buildGetRecommendArticleListExecuteParams: orders limit before offset', () => {
  const { buildGetRecommendArticleListExecuteParams } = loadHelper();
  assert.deepEqual(buildGetRecommendArticleListExecuteParams(5, 15), [15, 5]);
});

test('buildGetArticleByIdSql: does not coerce empty tags/images to jsonb []', () => {
  const { buildGetArticleByIdSql } = loadHelper();
  const sql = buildGetArticleByIdSql('https://api.example', 'https://app.example');
  assert.doesNotMatch(sql, /'\[\]'::jsonb/);
});

test('buildGetArticleByIdSql: separates image and video aggregates for detail payload', () => {
  const { buildGetArticleByIdSql } = loadHelper();
  const sql = buildGetArticleByIdSql('https://api.example', 'https://app.example');
  assert.match(sql, /WHERE\s+f\.article_id\s*=\s*a\.id\s+AND\s*\(\s*f\.file_type\s*=\s*'image'\s+OR\s+f\.file_type\s+IS\s+NULL\s*\)/i);
  assert.match(
    sql,
    /jsonb_agg\s*\(\s*jsonb_build_object\s*\([\s\S]*?'id',\s*f\.id,[\s\S]*?'url',\s*CONCAT\('https:\/\/api\.example\/article\/video\/',\s*f\.filename\)[\s\S]*?'poster',[\s\S]*?LEFT JOIN\s+video_meta\s+vm\s+ON\s+f\.id\s*=\s*vm\.file_id[\s\S]*?WHERE\s+f\.article_id\s*=\s*a\.id\s+AND\s+f\.file_type\s*=\s*'video'[\s\S]*?\)\s+videos/i,
  );
});

test('buildGetArticleListSql: does not coerce empty tags to jsonb []', () => {
  const { buildGetArticleListSql } = loadHelper();
  const sql = buildGetArticleListSql('https://api.example', 'https://app.example', {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.doesNotMatch(sql, /'\[\]'::jsonb/);
  assert.doesNotMatch(sql, /COALESCE\s*\(\s*tags_agg\.tags/i);
});

test('buildGetArticleListSql: cover uses LATERAL + LIMIT 1 instead of MAX(f.filename)', () => {
  const { buildGetArticleListSql } = loadHelper();
  const sql = buildGetArticleListSql('https://api.example', 'https://app.example', {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.doesNotMatch(sql, /MAX\s*\(\s*f\.filename\s*\)/i);
  assert.match(sql, /LEFT JOIN\s+LATERAL\s*\(/i);
  assert.match(sql, /im\.is_cover\s*=\s*TRUE[\s\S]*?LIMIT\s+1/i);
});

test('buildAddArticleSql: appends RETURNING id', () => {
  const { buildAddArticleSql } = loadHelper();

  assert.match(
    buildAddArticleSql(),
    /INSERT INTO article \(user_id,title, content, excerpt\) VALUES \(\?,\?,\?::jsonb,\?\) RETURNING id;$/i
  );
});
