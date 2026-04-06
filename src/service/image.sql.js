function buildAddImageFileSql(dialect) {
  const returning = dialect === 'pg' ? ' RETURNING id' : '';
  return `INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'image')${returning};`;
}

function buildClearImageCoverSql(dialect) {
  if (dialect === 'pg') {
    return `
        UPDATE image_meta AS im
        SET is_cover = FALSE
        FROM file AS f
        WHERE im.file_id = f.id
          AND f.article_id = ?
          AND f.file_type = 'image';
      `;
  }

  return `
        UPDATE image_meta im
        INNER JOIN file f ON im.file_id = f.id
        SET im.is_cover = FALSE
        WHERE f.article_id = ? AND f.file_type = 'image';
      `;
}

function buildSetImageCoverSql(dialect) {
  if (dialect === 'pg') {
    return `
          UPDATE image_meta AS im
          SET is_cover = TRUE
          FROM file AS f
          WHERE im.file_id = f.id
            AND f.id = ?
            AND f.article_id = ?
            AND f.file_type = 'image';
        `;
  }

  return `
          UPDATE image_meta im
          INNER JOIN file f ON im.file_id = f.id
          SET im.is_cover = TRUE
          WHERE f.id = ? AND f.article_id = ? AND f.file_type = 'image';
        `;
}

module.exports = {
  buildAddImageFileSql,
  buildClearImageCoverSql,
  buildSetImageCoverSql,
};
