const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/article.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected article.sql helper module to exist');
  return require(helperPath);
};

test('buildGetArticleByIdSql: pg uses jsonb_build_object/jsonb_agg, quoted user table; mysql keeps JSON_*', () => {
  const { buildGetArticleByIdSql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';

  const pgSql = buildGetArticleByIdSql('pg', base, redirect);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /jsonb_agg\s*\(\s*jsonb_build_object/i);
  assert.match(pgSql, /a\.create_at\s+AS\s+"createAt"/i);
  assert.match(pgSql, /a\.update_at\s+AS\s+"updateAt"/i);
  assert.match(pgSql, /\)\s+AS\s+"commentCount"/i);
  assert.match(pgSql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
  assert.doesNotMatch(pgSql, /JSON_OBJECT/i);
  assert.doesNotMatch(pgSql, /JSON_ARRAYAGG/i);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
  assert.doesNotMatch(pgSql, /LEFT JOIN\s+user\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);

  const mysqlSql = buildGetArticleByIdSql('mysql', base, redirect);
  assert.match(mysqlSql, /JSON_OBJECT\s*\(\s*'id',\s*u\.id/i);
  assert.match(mysqlSql, /JSON_ARRAYAGG\s*\(\s*JSON_OBJECT/i);
  assert.match(mysqlSql, /LEFT JOIN\s+user\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
});

test('buildGetArticleListSql: pg uses optimized-style shape (no GROUP BY), jsonb_*, LIMIT ? OFFSET ?', () => {
  const { buildGetArticleListSql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';

  const pgSql = buildGetArticleListSql('pg', base, redirect, {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.doesNotMatch(pgSql, /\bGROUP BY\s+a\.id\b/i);
  assert.match(pgSql, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(pgSql, /jsonb_agg\s*\(\s*jsonb_build_object/i);
  assert.match(pgSql, /a\.create_at\s+AS\s+"createAt"/i);
  assert.match(pgSql, /a\.update_at\s+AS\s+"updateAt"/i);
  assert.match(pgSql, /COALESCE\(comment_agg\.commentCount,\s*0\)\s+AS\s+"commentCount"/i);
  assert.match(pgSql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+\?\s*,\s*\?/);
  assert.match(pgSql, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);

  const mysqlSql = buildGetArticleListSql('mysql', base, redirect, {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.match(mysqlSql, /\bGROUP BY\s+a\.id\b/i);
  assert.match(mysqlSql, /JSON_OBJECT/i);
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/);
});

test('buildGetArticleListOptimizedSql: pg matches list pg branch dialect markers', () => {
  const { buildGetArticleListOptimizedSql, buildGetArticleListSql } = loadHelper();
  const base = 'https://api.example';
  const redirect = 'https://app.example';
  const opts = { tagId: '', userId: '', idList: [], keywords: '', pageOrder: 'date' };

  const a = buildGetArticleListOptimizedSql('pg', base, redirect, opts);
  const b = buildGetArticleListSql('pg', base, redirect, opts);
  assert.equal(a.replace(/\s+/g, ' ').trim(), b.replace(/\s+/g, ' ').trim());
});

test('buildArticleListExecuteParams: pg orders limit before offset', () => {
  const { buildArticleListExecuteParams } = loadHelper();
  assert.deepEqual(buildArticleListExecuteParams('mysql', [1, 2], 20, 10), [1, 2, 20, 10]);
  assert.deepEqual(buildArticleListExecuteParams('pg', [1, 2], 20, 10), [1, 2, 10, 20]);
});

test('buildGetArticlesByKeyWordsSql: pg uses LIMIT ? OFFSET ?; mysql keeps LIMIT 0,10', () => {
  const { buildGetArticlesByKeyWordsSql } = loadHelper();
  const redirect = 'https://app.example';

  const pgSql = buildGetArticlesByKeyWordsSql('pg', redirect);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.match(pgSql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);
  assert.doesNotMatch(pgSql, /LIMIT\s+0\s*,\s*10/i);

  const mysqlSql = buildGetArticlesByKeyWordsSql('mysql', redirect);
  assert.match(mysqlSql, /LIMIT\s+0\s*,\s*10/i);
});

test('buildGetArticlesByKeyWordsExecuteParams: pg appends limit and offset after pattern', () => {
  const { buildGetArticlesByKeyWordsExecuteParams } = loadHelper();
  assert.deepEqual(buildGetArticlesByKeyWordsExecuteParams('mysql', 'kw'), ['%kw%']);
  assert.deepEqual(buildGetArticlesByKeyWordsExecuteParams('pg', 'kw'), ['%kw%', 10, 0]);
});

test('buildGetRecommendArticleListSql: pg uses LIMIT ? OFFSET ?', () => {
  const { buildGetRecommendArticleListSql } = loadHelper();
  const redirect = 'https://app.example';

  const pgSql = buildGetRecommendArticleListSql('pg', redirect);
  assert.match(pgSql, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.match(pgSql, /CONCAT\('[^']*\/article\/',\s*a\.id\)\s+AS\s+"articleUrl"/i);

  const mysqlSql = buildGetRecommendArticleListSql('mysql', redirect);
  assert.match(mysqlSql, /LIMIT\s+\?\s*,\s*\?/i);
});

test('buildGetRecommendArticleListExecuteParams: pg orders limit before offset', () => {
  const { buildGetRecommendArticleListExecuteParams } = loadHelper();
  assert.deepEqual(buildGetRecommendArticleListExecuteParams('mysql', 5, 15), [5, 15]);
  assert.deepEqual(buildGetRecommendArticleListExecuteParams('pg', 5, 15), [15, 5]);
});

test('buildGetArticleByIdSql: pg does not coerce empty tags/images to jsonb [] (MySQL NULL parity)', () => {
  const { buildGetArticleByIdSql } = loadHelper();
  const pgSql = buildGetArticleByIdSql('pg', 'https://api.example', 'https://app.example');
  assert.doesNotMatch(pgSql, /'\[\]'::jsonb/);
});

test('buildGetArticleListSql: pg does not coerce empty tags to jsonb [] (MySQL NULL parity)', () => {
  const { buildGetArticleListSql } = loadHelper();
  const pgSql = buildGetArticleListSql('pg', 'https://api.example', 'https://app.example', {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.doesNotMatch(pgSql, /'\[\]'::jsonb/);
  assert.doesNotMatch(pgSql, /COALESCE\s*\(\s*tags_agg\.tags/i);
});

test('buildGetArticleListSql: pg cover uses LATERAL + LIMIT 1 instead of MAX(f.filename)', () => {
  const { buildGetArticleListSql } = loadHelper();
  const pgSql = buildGetArticleListSql('pg', 'https://api.example', 'https://app.example', {
    tagId: '',
    userId: '',
    idList: [],
    keywords: '',
    pageOrder: 'date',
  });
  assert.doesNotMatch(pgSql, /MAX\s*\(\s*f\.filename\s*\)/i);
  assert.match(pgSql, /LEFT JOIN\s+LATERAL\s*\(/i);
  assert.match(pgSql, /im\.is_cover\s*=\s*TRUE[\s\S]*?LIMIT\s+1/i);
});

test('buildAddArticleSql: pg appends RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddArticleSql } = loadHelper();

  assert.equal(
    buildAddArticleSql('mysql'),
    'INSERT INTO article (user_id,title, content) VALUES (?,?,?);'
  );
  assert.match(
    buildAddArticleSql('pg'),
    /INSERT INTO article \(user_id,title, content\) VALUES \(\?,\?,\?\) RETURNING id;$/i
  );
});
