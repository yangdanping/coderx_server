const VIDEO_METADATA_FIELDS = ['duration', 'width', 'height', 'bitrate', 'format'];

function buildAddVideoFileSql(dialect) {
  const returning = dialect === 'pg' ? ' RETURNING id' : '';
  return `INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'video')${returning};`;
}

function buildUpdateVideoPosterSql(dialect) {
  if (dialect === 'pg') {
    return 'UPDATE video_meta AS vm SET poster = ? FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;';
  }

  return 'UPDATE video_meta vm INNER JOIN file f ON vm.file_id = f.id SET vm.poster = ? WHERE f.id = ?;';
}

function buildVideoMetadataAssignments(dialect, metadata) {
  const prefix = dialect === 'pg' ? '' : 'vm.';
  return VIDEO_METADATA_FIELDS.filter((field) => metadata[field] !== undefined).map((field) => `${prefix}${field} = ?`);
}

function buildVideoMetadataValues(metadata) {
  return VIDEO_METADATA_FIELDS.filter((field) => metadata[field] !== undefined).map((field) => metadata[field]);
}

function buildUpdateVideoMetadataSql(dialect, assignments) {
  if (dialect === 'pg') {
    return `UPDATE video_meta AS vm SET ${assignments.join(', ')} FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;`;
  }

  return `UPDATE video_meta vm INNER JOIN file f ON vm.file_id = f.id SET ${assignments.join(', ')} WHERE f.id = ?;`;
}

function buildUpdateTranscodeStatusSql(dialect) {
  if (dialect === 'pg') {
    return 'UPDATE video_meta AS vm SET transcode_status = ? FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;';
  }

  return 'UPDATE video_meta vm INNER JOIN file f ON vm.file_id = f.id SET vm.transcode_status = ? WHERE f.id = ?;';
}

module.exports = {
  buildAddVideoFileSql,
  buildVideoMetadataValues,
  buildUpdateTranscodeStatusSql,
  buildUpdateVideoMetadataSql,
  buildUpdateVideoPosterSql,
  buildVideoMetadataAssignments,
};
