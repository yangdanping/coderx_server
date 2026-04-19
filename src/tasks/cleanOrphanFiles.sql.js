const {
  buildDeleteConsumedDraftsSql: buildDeleteConsumedDraftsSqlFromDraftSql,
  buildDeleteDiscardedDraftsSql: buildDeleteDiscardedDraftsSqlFromDraftSql,
  buildDeleteExpiredActiveDraftsSql: buildDeleteExpiredActiveDraftsSqlFromDraftSql,
} = require('../service/sql/draft.sql');

function normalizeThresholdUnit(unit) {
  const normalized = String(unit || '').toUpperCase();
  if (!['SECOND', 'HOUR', 'DAY'].includes(normalized)) {
    throw new Error(`Unsupported threshold unit: ${unit}`);
  }
  return normalized;
}

function buildAgeExpression(unit) {
  switch (unit) {
    case 'SECOND':
      return 'FLOOR(EXTRACT(EPOCH FROM (NOW() - f.create_at)))::integer';
    case 'HOUR':
      return 'FLOOR(EXTRACT(EPOCH FROM (NOW() - f.create_at)) / 3600)::integer';
    case 'DAY':
      return 'FLOOR(EXTRACT(EPOCH FROM (NOW() - f.create_at)) / 86400)::integer';
    default:
      throw new Error(`Unsupported threshold unit: ${unit}`);
  }
}

function buildCutoffExpression(unit) {
  switch (unit) {
    case 'SECOND':
      return "NOW() - (? * INTERVAL '1 second')";
    case 'HOUR':
      return "NOW() - (? * INTERVAL '1 hour')";
    case 'DAY':
      return "NOW() - (? * INTERVAL '1 day')";
    default:
      throw new Error(`Unsupported threshold unit: ${unit}`);
  }
}

function buildFindOrphanFilesSql(fileType, unit) {
  const normalizedUnit = normalizeThresholdUnit(unit);
  const ageExpression = `${buildAgeExpression(normalizedUnit)} as age_in_units`;
  const cutoffExpression = buildCutoffExpression(normalizedUnit);

  if (fileType === 'image') {
    return `
        SELECT
          f.id,
          f.filename,
          f.mimetype,
          f.size,
          f.create_at as createTime,
          ${ageExpression}
        FROM file f
        LEFT JOIN video_meta vm ON f.filename = vm.poster
        WHERE f.article_id IS NULL
          AND f.draft_id IS NULL
          AND vm.poster IS NULL
          AND f.file_type = ?
          AND f.create_at < ${cutoffExpression}
        ORDER BY f.create_at ASC
        `;
  }

  if (fileType === 'video') {
    // 通过 LEFT JOIN video_meta 把封面文件名带出来，下游直接按 DB 字段删物理文件，
    // 不再依赖 "<name>-poster.jpg" 的命名约定（未来若引入多分辨率封面也能扛住）
    return `
        SELECT
          f.id,
          f.filename,
          f.mimetype,
          f.size,
          f.create_at as createTime,
          vm.poster,
          ${ageExpression}
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE f.article_id IS NULL
          AND f.draft_id IS NULL
          AND f.file_type = ?
          AND f.create_at < ${cutoffExpression}
        ORDER BY f.create_at ASC
        `;
  }

  throw new Error(`不支持的文件类型: ${fileType}`);
}

function buildDeleteConsumedDraftsSql(unit = 'DAY') {
  return buildDeleteConsumedDraftsSqlFromDraftSql('?', unit);
}

function buildDeleteDiscardedDraftsSql(unit = 'DAY') {
  return buildDeleteDiscardedDraftsSqlFromDraftSql('?', unit);
}

function buildDeleteExpiredActiveDraftsSql(unit = 'DAY') {
  return buildDeleteExpiredActiveDraftsSqlFromDraftSql('?', unit);
}

module.exports = {
  buildFindOrphanFilesSql,
  buildDeleteConsumedDraftsSql,
  buildDeleteDiscardedDraftsSql,
  buildDeleteExpiredActiveDraftsSql,
};
