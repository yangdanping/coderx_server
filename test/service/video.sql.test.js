const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/video.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected video.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddVideoFileSql: pg requests RETURNING id while mysql keeps legacy insert', () => {
  const { buildAddVideoFileSql } = loadHelper();

  assert.equal(
    buildAddVideoFileSql('mysql'),
    "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'video');"
  );
  assert.match(
    buildAddVideoFileSql('pg'),
    /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'video'\) RETURNING id;/i
  );
});

test('buildUpdateVideoPosterSql: pg rewrites update inner join to update from syntax', () => {
  const { buildUpdateVideoPosterSql } = loadHelper();

  const pgSql = buildUpdateVideoPosterSql('pg');
  assert.match(pgSql, /UPDATE video_meta AS vm/i);
  assert.match(pgSql, /SET poster = \?/i);
  assert.match(pgSql, /FROM file AS f/i);
  assert.match(pgSql, /vm\.file_id = f\.id/i);
  assert.doesNotMatch(pgSql, /INNER JOIN/i);

  const mysqlSql = buildUpdateVideoPosterSql('mysql');
  assert.match(mysqlSql, /UPDATE video_meta vm INNER JOIN file f ON vm\.file_id = f\.id/i);
  assert.match(mysqlSql, /SET vm\.poster = \?/i);
});

test('buildVideoMetadataAssignments: pg drops target alias in SET clauses while mysql keeps vm prefix', () => {
  const { buildVideoMetadataAssignments } = loadHelper();

  assert.deepEqual(buildVideoMetadataAssignments('pg', { duration: 12, format: 'mp4' }), ['duration = ?', 'format = ?']);
  assert.deepEqual(buildVideoMetadataAssignments('mysql', { duration: 12, format: 'mp4' }), ['vm.duration = ?', 'vm.format = ?']);
});

test('buildVideoMetadataValues: preserves the canonical parameter order for metadata updates', () => {
  const { buildVideoMetadataValues } = loadHelper();

  assert.deepEqual(
    buildVideoMetadataValues({
      format: 'mp4',
      duration: 12,
      bitrate: 800,
      width: 640,
    }),
    [12, 640, 800, 'mp4']
  );
});

test('buildUpdateVideoMetadataSql: pg rewrites update join to update from syntax', () => {
  const { buildUpdateVideoMetadataSql } = loadHelper();

  const pgSql = buildUpdateVideoMetadataSql('pg', ['duration = ?', 'format = ?']);
  assert.match(pgSql, /UPDATE video_meta AS vm/i);
  assert.match(pgSql, /SET duration = \?, format = \?/i);
  assert.match(pgSql, /FROM file AS f/i);
  assert.doesNotMatch(pgSql, /INNER JOIN/i);

  const mysqlSql = buildUpdateVideoMetadataSql('mysql', ['vm.duration = ?', 'vm.format = ?']);
  assert.match(mysqlSql, /UPDATE video_meta vm INNER JOIN file f ON vm\.file_id = f\.id/i);
  assert.match(mysqlSql, /SET vm\.duration = \?, vm\.format = \?/i);
});

test('buildUpdateTranscodeStatusSql: pg rewrites update inner join to update from syntax', () => {
  const { buildUpdateTranscodeStatusSql } = loadHelper();

  const pgSql = buildUpdateTranscodeStatusSql('pg');
  assert.match(pgSql, /UPDATE video_meta AS vm/i);
  assert.match(pgSql, /SET transcode_status = \?/i);
  assert.match(pgSql, /FROM file AS f/i);
  assert.doesNotMatch(pgSql, /INNER JOIN/i);

  const mysqlSql = buildUpdateTranscodeStatusSql('mysql');
  assert.match(mysqlSql, /UPDATE video_meta vm INNER JOIN file f ON vm\.file_id = f\.id/i);
  assert.match(mysqlSql, /SET vm\.transcode_status = \?/i);
});
