const VIDEO_METADATA_FIELDS = ['duration', 'width', 'height', 'bitrate', 'format'];

function buildAddVideoFileSql() {
  return "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'video') RETURNING id;";
}

function buildUpdateVideoPosterSql() {
  return 'UPDATE video_meta AS vm SET poster = ? FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;';
}

function buildVideoMetadataAssignments(metadata) {
  return VIDEO_METADATA_FIELDS.filter((field) => metadata[field] !== undefined).map((field) => `${field} = ?`);
}

function buildVideoMetadataValues(metadata) {
  return VIDEO_METADATA_FIELDS.filter((field) => metadata[field] !== undefined).map((field) => metadata[field]);
}

function buildUpdateVideoMetadataSql(assignments) {
  return `UPDATE video_meta AS vm SET ${assignments.join(', ')} FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;`;
}

function buildUpdateTranscodeStatusSql() {
  return 'UPDATE video_meta AS vm SET transcode_status = ? FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;';
}

module.exports = {
  buildAddVideoFileSql,
  buildVideoMetadataValues,
  buildUpdateTranscodeStatusSql,
  buildUpdateVideoMetadataSql,
  buildUpdateVideoPosterSql,
  buildVideoMetadataAssignments,
};
