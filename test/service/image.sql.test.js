const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/image.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected image.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddImageFileSql: requests RETURNING id', () => {
  const { buildAddImageFileSql } = loadHelper();

  assert.match(
    buildAddImageFileSql(),
    /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'image'\) RETURNING id;/i
  );
});

test('buildClearImageCoverSql: rewrites update join to update from syntax', () => {
  const { buildClearImageCoverSql } = loadHelper();

  const sql = buildClearImageCoverSql();
  assert.match(sql, /UPDATE image_meta AS im/i);
  assert.match(sql, /SET is_cover = FALSE/i);
  assert.match(sql, /FROM file AS f/i);
  assert.match(sql, /im\.file_id = f\.id/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});

test('buildSetImageCoverSql: rewrites join update and keeps cover filters', () => {
  const { buildSetImageCoverSql } = loadHelper();

  const sql = buildSetImageCoverSql();
  assert.match(sql, /UPDATE image_meta AS im/i);
  assert.match(sql, /SET is_cover = TRUE/i);
  assert.match(sql, /FROM file AS f/i);
  assert.match(sql, /f\.id = \?/i);
  assert.match(sql, /f\.article_id = \?/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});
