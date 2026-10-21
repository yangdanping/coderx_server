function buildArticleImageDraftScope() {
  return `(
    f.draft_id IS NULL OR EXISTS (
      SELECT 1 FROM draft d
      WHERE d.id = f.draft_id
        AND d.user_id = f.user_id
        AND d.draft_type = 'article'
        AND d.status = 'consumed'
        AND d.consumed_article_id = ?
    )
  )`;
}

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
  buildArticleImageDraftScope,
  buildAddImageFileSql,
  buildClearImageCoverSql,
  buildSetImageCoverSql,
};
