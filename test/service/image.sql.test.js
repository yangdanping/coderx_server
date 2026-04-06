const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/image.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected image.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddImageFileSql: pg requests RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddImageFileSql } = loadHelper();

  assert.equal(
    buildAddImageFileSql('mysql'),
    "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'image');"
  );
  assert.match(
    buildAddImageFileSql('pg'),
    /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'image'\) RETURNING id;/i
  );
});

test('buildClearImageCoverSql: pg rewrites update inner join to update from syntax', () => {
  const { buildClearImageCoverSql } = loadHelper();

  const pgSql = buildClearImageCoverSql('pg');
  assert.match(pgSql, /UPDATE image_meta AS im/i);
  assert.match(pgSql, /SET is_cover = FALSE/i);
  assert.match(pgSql, /FROM file AS f/i);
  assert.match(pgSql, /im\.file_id = f\.id/i);
  assert.doesNotMatch(pgSql, /INNER JOIN/i);

  const mysqlSql = buildClearImageCoverSql('mysql');
  assert.match(mysqlSql, /UPDATE image_meta im/i);
  assert.match(mysqlSql, /INNER JOIN file f ON im\.file_id = f\.id/i);
});

test('buildSetImageCoverSql: pg rewrites join update and keeps cover filters', () => {
  const { buildSetImageCoverSql } = loadHelper();

  const pgSql = buildSetImageCoverSql('pg');
  assert.match(pgSql, /UPDATE image_meta AS im/i);
  assert.match(pgSql, /SET is_cover = TRUE/i);
  assert.match(pgSql, /FROM file AS f/i);
  assert.match(pgSql, /f\.id = \?/i);
  assert.match(pgSql, /f\.article_id = \?/i);
  assert.doesNotMatch(pgSql, /INNER JOIN/i);

  const mysqlSql = buildSetImageCoverSql('mysql');
  assert.match(mysqlSql, /UPDATE image_meta im/i);
  assert.match(mysqlSql, /INNER JOIN file f ON im\.file_id = f\.id/i);
  assert.match(mysqlSql, /SET im\.is_cover = TRUE/i);
});
