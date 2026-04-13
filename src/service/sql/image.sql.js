function buildAddImageFileSql() {
  return "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES (?,?,?,?,'image') RETURNING id;";
}

function buildClearImageCoverSql() {
  return `
        UPDATE image_meta AS im
        SET is_cover = FALSE
        FROM file AS f
        WHERE im.file_id = f.id
          AND f.article_id = ?
          AND f.file_type = 'image';
      `;
}

function buildSetImageCoverSql() {
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

module.exports = {
  buildAddImageFileSql,
  buildClearImageCoverSql,
  buildSetImageCoverSql,
};
