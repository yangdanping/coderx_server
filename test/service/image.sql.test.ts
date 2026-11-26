import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAddImageFileSql, buildClearImageCoverSql, buildSetImageCoverSql } from '../../src/service/sql/image.sql.js';

test('buildAddImageFileSql: requests RETURNING id', () => {
  assert.match(
    buildAddImageFileSql(),
    /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'image'\) RETURNING id;/i
  );
});

test('buildClearImageCoverSql: rewrites update join to update from syntax', () => {
  const sql = buildClearImageCoverSql();
  assert.match(sql, /UPDATE image_meta AS im/i);
  assert.match(sql, /SET is_cover = FALSE/i);
  assert.match(sql, /FROM file AS f/i);
  assert.match(sql, /im\.file_id = f\.id/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});

test('buildSetImageCoverSql: rewrites join update and keeps cover filters', () => {
  const sql = buildSetImageCoverSql();
  assert.match(sql, /UPDATE image_meta AS im/i);
  assert.match(sql, /SET is_cover = TRUE/i);
  assert.match(sql, /FROM file AS f/i);
  assert.match(sql, /f\.id = \?/i);
  assert.match(sql, /f\.article_id = \?/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});
