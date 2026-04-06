const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/tasks/cleanOrphanFiles.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected cleanOrphanFiles.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildFindOrphanFilesSql: pg replaces MySQL time functions for image cleanup query', () => {
  const { buildFindOrphanFilesSql } = loadHelper();

  const pgSql = buildFindOrphanFilesSql('pg', 'image', 'DAY');
  assert.match(pgSql, /EXTRACT\(EPOCH FROM \(NOW\(\) - f\.create_at\)\)/i);
  assert.match(pgSql, /NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.doesNotMatch(pgSql, /TIMESTAMPDIFF/i);
  assert.doesNotMatch(pgSql, /DATE_SUB/i);
  assert.match(pgSql, /LEFT JOIN video_meta vm ON f\.filename = vm\.poster/i);
  assert.match(pgSql, /vm\.poster IS NULL/i);

  const mysqlSql = buildFindOrphanFilesSql('mysql', 'image', 'DAY');
  assert.match(mysqlSql, /TIMESTAMPDIFF\(DAY,\s*f\.create_at,\s*NOW\(\)\)\s+as age_in_units/i);
  assert.match(mysqlSql, /f\.create_at < DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/i);
});

test('buildFindOrphanFilesSql: pg replaces MySQL time functions for video cleanup query', () => {
  const { buildFindOrphanFilesSql } = loadHelper();

  const pgSql = buildFindOrphanFilesSql('pg', 'video', 'SECOND');
  assert.match(pgSql, /FLOOR\(EXTRACT\(EPOCH FROM \(NOW\(\) - f\.create_at\)\)\)::integer as age_in_units/i);
  assert.match(pgSql, /NOW\(\) - \(\? \* INTERVAL '1 second'\)/i);
  assert.doesNotMatch(pgSql, /TIMESTAMPDIFF/i);
  assert.doesNotMatch(pgSql, /DATE_SUB/i);

  const mysqlSql = buildFindOrphanFilesSql('mysql', 'video', 'SECOND');
  assert.match(mysqlSql, /TIMESTAMPDIFF\(SECOND,\s*f\.create_at,\s*NOW\(\)\)\s+as age_in_units/i);
  assert.match(mysqlSql, /f\.create_at < DATE_SUB\(NOW\(\), INTERVAL \? SECOND\)/i);
});
