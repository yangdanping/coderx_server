import type { VideoMetadata } from '../video.types.js';

const VIDEO_METADATA_FIELDS: readonly (keyof VideoMetadata)[] = ['duration', 'width', 'height', 'bitrate', 'format'];

export function buildAddVideoFileSql() {
  return "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'video') RETURNING id;";
}

export function buildUpdateVideoPosterSql() {
  return 'UPDATE video_meta AS vm SET poster = ? FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;';
}

export function buildVideoMetadataAssignments(metadata: Partial<VideoMetadata>) {
  return VIDEO_METADATA_FIELDS.filter((field) => metadata[field] !== undefined).map((field) => `${field} = ?`);
}

export function buildVideoMetadataValues(metadata: Partial<VideoMetadata>) {
  return VIDEO_METADATA_FIELDS.filter((field) => metadata[field] !== undefined).map((field) => metadata[field]);
}

export function buildUpdateVideoMetadataSql(assignments: readonly string[]) {
  return `UPDATE video_meta AS vm SET ${assignments.join(', ')} FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;`;
}

export function buildUpdateTranscodeStatusSql() {
  return 'UPDATE video_meta AS vm SET transcode_status = ? FROM file AS f WHERE vm.file_id = f.id AND f.id = ?;';
}
