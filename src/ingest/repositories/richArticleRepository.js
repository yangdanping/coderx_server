function createRichArticleRepository(database) {
  async function replacePublishedArticle({ articleId, candidateId, authorId, createAt, title, excerpt, assets, buildContent }) {
    if (!Number.isSafeInteger(articleId) || articleId <= 0) throw new Error('articleId must be a positive integer');
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new Error('candidateId must be a positive integer');
    if (!Number.isSafeInteger(authorId) || authorId <= 0) throw new Error('authorId must be a positive integer');
    if (!(createAt instanceof Date) || Number.isNaN(createAt.getTime())) throw new Error('createAt must be a valid Date');
    if (!String(title || '').trim() || !String(excerpt || '').trim()) throw new Error('title and excerpt are required');
    if (!Array.isArray(assets) || assets.length === 0) throw new Error('assets are required');
    if (typeof buildContent !== 'function') throw new Error('buildContent is required');

    const connection = await database.getConnection();
    try {
      await connection.beginTransaction();
      const [articleRows] = await connection.execute(
        `
          SELECT a.id AS "articleId"
          FROM article_source ars
          JOIN article a ON a.id = ars.article_id
          WHERE ars.candidate_id = ?
            AND a.id = ?
          FOR UPDATE OF a;
        `,
        [candidateId, articleId],
      );
      if (!articleRows[0]) throw new Error(`Published article mapping not found for candidate ${candidateId}`);

      const [authorRows] = await connection.execute(
        `
          SELECT u.id
          FROM "user" u
          JOIN profile p ON p.user_id = u.id
          WHERE u.id = ?
            AND u.status = 0
            AND NULLIF(BTRIM(COALESCE(p.avatar_url, '')), '') IS NOT NULL
          LIMIT 1;
        `,
        [authorId],
      );
      if (!authorRows[0]) throw new Error(`Approved existing author not found: ${authorId}`);

      const ingestPrefix = `ingest-${candidateId}-%`;
      const [oldImages] = await connection.execute(
        `
          SELECT f.id,
                 f.filename
          FROM file f
          WHERE f.article_id = ?
            AND f.file_type = 'image'
            AND f.filename LIKE ?
          FOR UPDATE;
        `,
        [articleId, ingestPrefix],
      );
      if (oldImages.length > 0) {
        await connection.execute(
          `
            DELETE FROM file
            WHERE id = ANY(?::bigint[]);
          `,
          [oldImages.map((image) => image.id)],
        );
      }

      const imageRows = [];
      for (const asset of assets) {
        const [fileResult] = await connection.execute(
          `
            INSERT INTO file (user_id, article_id, filename, mimetype, size, file_type)
            VALUES (?, ?, ?, ?, ?, 'image')
            RETURNING id;
          `,
          [authorId, articleId, asset.filename, asset.mimetype, asset.size],
        );
        const imageId = fileResult.insertId;
        await connection.execute(
          `
            INSERT INTO image_meta (file_id, width, height, is_cover)
            VALUES (?, ?, ?, ?);
          `,
          [imageId, asset.width, asset.height, asset.isCover === true],
        );
        imageRows.push({ ...asset, id: imageId });
      }

      const content = buildContent(imageRows);
      const [updateResult] = await connection.execute(
        `
          UPDATE article
          SET user_id = ?,
              title = ?,
              content = ?::jsonb,
              excerpt = ?,
              create_at = ?,
              update_at = clock_timestamp()
          WHERE id = ?;
        `,
        [authorId, String(title).trim(), JSON.stringify(content), String(excerpt).trim(), createAt, articleId],
      );
      if (updateResult.affectedRows !== 1) throw new Error(`Article ${articleId} changed during rich replacement`);

      await connection.commit();
      return {
        articleId,
        images: imageRows,
        oldFilenames: oldImages.map((image) => image.filename),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  return {
    replacePublishedArticle,
  };
}

module.exports = {
  createRichArticleRepository,
};
