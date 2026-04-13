const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/video.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected video.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildAddVideoFileSql: requests RETURNING id', () => {
  const { buildAddVideoFileSql } = loadHelper();

  assert.match(
    buildAddVideoFileSql(),
    /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'video'\) RETURNING id;/i
  );
});

test('buildUpdateVideoPosterSql: rewrites update join to update from syntax', () => {
  const { buildUpdateVideoPosterSql } = loadHelper();

  const sql = buildUpdateVideoPosterSql();
  assert.match(sql, /UPDATE video_meta AS vm/i);
  assert.match(sql, /SET poster = \?/i);
  assert.match(sql, /FROM file AS f/i);
  assert.match(sql, /vm\.file_id = f\.id/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});

test('buildVideoMetadataAssignments: uses unqualified SET clauses', () => {
  const { buildVideoMetadataAssignments } = loadHelper();

  assert.deepEqual(buildVideoMetadataAssignments({ duration: 12, format: 'mp4' }), ['duration = ?', 'format = ?']);
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

test('buildUpdateVideoMetadataSql: rewrites update join to update from syntax', () => {
  const { buildUpdateVideoMetadataSql } = loadHelper();

  const sql = buildUpdateVideoMetadataSql(['duration = ?', 'format = ?']);
  assert.match(sql, /UPDATE video_meta AS vm/i);
  assert.match(sql, /SET duration = \?, format = \?/i);
  assert.match(sql, /FROM file AS f/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});

test('buildUpdateTranscodeStatusSql: rewrites update join to update from syntax', () => {
  const { buildUpdateTranscodeStatusSql } = loadHelper();

  const sql = buildUpdateTranscodeStatusSql();
  assert.match(sql, /UPDATE video_meta AS vm/i);
  assert.match(sql, /SET transcode_status = \?/i);
  assert.match(sql, /FROM file AS f/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});
