import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAddVideoFileSql,
  buildUpdateTranscodeStatusSql,
  buildUpdateVideoMetadataSql,
  buildUpdateVideoPosterSql,
  buildVideoMetadataAssignments,
  buildVideoMetadataValues,
} from '../../src/service/sql/video.sql.js';

test('buildAddVideoFileSql: requests RETURNING id', () => {
  assert.match(
    buildAddVideoFileSql(),
    /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'video'\) RETURNING id;/i
  );
});

test('buildUpdateVideoPosterSql: rewrites update join to update from syntax', () => {
  const sql = buildUpdateVideoPosterSql();
  assert.match(sql, /UPDATE video_meta AS vm/i);
  assert.match(sql, /SET poster = \?/i);
  assert.match(sql, /FROM file AS f/i);
  assert.match(sql, /vm\.file_id = f\.id/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});

test('buildVideoMetadataAssignments: uses unqualified SET clauses', () => {
  assert.deepEqual(buildVideoMetadataAssignments({ duration: 12, format: 'mp4' }), ['duration = ?', 'format = ?']);
});

test('buildVideoMetadataValues: preserves the canonical parameter order for metadata updates', () => {
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
  const sql = buildUpdateVideoMetadataSql(['duration = ?', 'format = ?']);
  assert.match(sql, /UPDATE video_meta AS vm/i);
  assert.match(sql, /SET duration = \?, format = \?/i);
  assert.match(sql, /FROM file AS f/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});

test('buildUpdateTranscodeStatusSql: rewrites update join to update from syntax', () => {
  const sql = buildUpdateTranscodeStatusSql();
  assert.match(sql, /UPDATE video_meta AS vm/i);
  assert.match(sql, /SET transcode_status = \?/i);
  assert.match(sql, /FROM file AS f/i);
  assert.doesNotMatch(sql, /INNER JOIN/i);
});
