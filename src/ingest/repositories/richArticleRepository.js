const { isPlaceholderArticle } = require('@/ingest/domain/isPlaceholderArticle');

function createRichArticleRepository(database) {
  const placeholderSelect = `
    SELECT
      a.id AS "articleId",
      c.id AS "candidateId",
      a.title,
      a.content,
      c.canonical_url AS "canonicalUrl",
      s.name AS "sourceName",
      COALESCE(
        (
          SELECT jsonb_agg(f.filename ORDER BY f.id)
          FROM file f
          WHERE f.article_id = a.id
        ),
        '[]'::jsonb
      ) AS filenames
    FROM article a
    JOIN ingest_candidate c ON c.article_id = a.id
    JOIN ingest_source s ON s.id = c.source_id
  `;

  async function listPublishedCandidatesByIds(ids) {
    const safeIds = Array.isArray(ids) ? ids.map(Number) : [];
    if (safeIds.length === 0 || safeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(safeIds).size !== safeIds.length) {
      throw new Error('ids must be unique positive integers');
    }
    const [rows] = await database.execute(
      `
        SELECT
          c.id,
          c.article_id AS "articleId",
          c.canonical_url AS "canonicalUrl",
          c.source_published_at AS "sourcePublishedAt",
          s.name AS "sourceName"
        FROM ingest_candidate c
        JOIN ingest_source s ON s.id = c.source_id
        JOIN article_source ars
          ON ars.candidate_id = c.id
         AND ars.article_id = c.article_id
        WHERE c.status = 'published'
          AND c.article_id IS NOT NULL
          AND c.id = ANY(?::bigint[])
        ORDER BY c.id;
      `,
      [safeIds],
    );
    return rows;
  }

  async function listRawCandidatesByIds(ids) {
    const safeIds = Array.isArray(ids) ? ids.map(Number) : [];
    if (
      safeIds.length === 0 ||
      safeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(safeIds).size !== safeIds.length
    ) {
      throw new Error('ids must be unique positive integers');
    }
    const [rows] = await database.execute(
      `
        SELECT
          c.id,
          c.article_id AS "articleId",
          c.status,
          c.source_id AS "sourceId",
          c.canonical_url AS "canonicalUrl",
          c.title_original AS "titleOriginal",
          c.source_published_at AS "sourcePublishedAt",
          c.content_mode AS "contentMode",
          c.license_code AS "licenseCode",
          s.name AS "sourceName"
        FROM ingest_candidate c
        JOIN ingest_source s ON s.id = c.source_id
        WHERE c.id = ANY(?::bigint[])
          AND (
            (
              c.status = 'pending'
              AND c.article_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM article_source ars
                WHERE ars.candidate_id = c.id
              )
            )
            OR
            (
              c.status = 'published'
              AND c.article_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM article_source ars
                WHERE ars.candidate_id = c.id
                  AND ars.article_id = c.article_id
              )
            )
          )
        ORDER BY c.id;
      `,
      [safeIds],
    );
    return rows;
  }

  async function publishRawArticle({ candidateId, authorId, createAt, tagName, title, excerpt, assets, buildContent }) {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new Error('candidateId must be a positive integer');
    if (!Number.isSafeInteger(authorId) || authorId <= 0) throw new Error('authorId must be a positive integer');
    if (!(createAt instanceof Date) || Number.isNaN(createAt.getTime())) throw new Error('createAt must be a valid Date');
    if (!String(tagName || '').trim()) throw new Error('tagName is required');
    if (!String(title || '').trim() || !String(excerpt || '').trim()) throw new Error('title and excerpt are required');
    if (!Array.isArray(assets) || assets.length === 0) throw new Error('assets are required');
    if (typeof buildContent !== 'function') throw new Error('buildContent is required');

    const connection = await database.getConnection();
    try {
      await connection.beginTransaction();

      const [candidateRows] = await connection.execute(
        `
          SELECT
            c.id,
            c.source_id AS "sourceId",
            c.canonical_url AS "canonicalUrl",
            c.title_original AS "titleOriginal",
            c.source_published_at AS "sourcePublishedAt",
            c.content_mode AS "contentMode",
            c.license_code AS "licenseCode"
          FROM ingest_candidate c
          WHERE c.id = ?
            AND c.status = 'pending'
            AND c.article_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM article_source ars
              WHERE ars.candidate_id = c.id
            )
          FOR UPDATE OF c;
        `,
        [candidateId],
      );
      const candidate = candidateRows[0];
      if (!candidate) throw new Error(`Eligible pending candidate not found: ${candidateId}`);

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

      const [tagRows] = await connection.execute(
        `
          SELECT id
          FROM tag
          WHERE name = ?
          LIMIT 1;
        `,
        [String(tagName).trim()],
      );
      const tag = tagRows[0];
      if (!tag) throw new Error(`Article tag not found: ${String(tagName).trim()}`);

      const [sourceRows] = await connection.execute(
        `
          SELECT article_id AS "articleId"
          FROM article_source
          WHERE canonical_url = ?
             OR candidate_id = ?
          LIMIT 1;
        `,
        [candidate.canonicalUrl, candidateId],
      );
      if (sourceRows[0]) throw new Error(`Source mapping already exists for candidate ${candidateId}`);

      const emptyContent = { type: 'doc', content: [] };
      const [articleResult] = await connection.execute(
        `
          INSERT INTO article (user_id, title, content, excerpt, create_at)
          VALUES (?, ?, ?::jsonb, ?, ?)
          RETURNING id;
        `,
        [authorId, String(title).trim(), JSON.stringify(emptyContent), String(excerpt).trim(), createAt],
      );
      const articleId = articleResult.insertId;

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
      const [contentResult] = await connection.execute(
        `
          UPDATE article
          SET content = ?::jsonb,
              update_at = clock_timestamp()
          WHERE id = ?;
        `,
        [JSON.stringify(content), articleId],
      );
      if (contentResult.affectedRows !== 1) throw new Error(`Article ${articleId} changed during raw publication`);

      await connection.execute(
        `
          INSERT INTO article_tag (article_id, tag_id)
          VALUES (?, ?);
        `,
        [articleId, tag.id],
      );
      await connection.execute(
        `
          INSERT INTO article_source (
            article_id, candidate_id, source_id, canonical_url, source_title,
            source_published_at, content_mode, license_code
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `,
        [
          articleId,
          candidateId,
          candidate.sourceId,
          candidate.canonicalUrl,
          candidate.titleOriginal,
          candidate.sourcePublishedAt,
          candidate.contentMode,
          candidate.licenseCode,
        ],
      );
      const [candidateResult] = await connection.execute(
        `
          UPDATE ingest_candidate
          SET article_id = ?,
              status = 'published',
              failure_reason = NULL,
              updated_at = clock_timestamp()
          WHERE id = ?
            AND status = 'pending'
            AND article_id IS NULL;
        `,
        [articleId, candidateId],
      );
      if (candidateResult.affectedRows !== 1) {
        throw new Error(`Candidate ${candidateId} changed during publication`);
      }

      await connection.commit();
      return {
        articleId,
        images: imageRows,
        oldFilenames: [],
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

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

  async function listPlaceholderArticles() {
    const [rows] = await database.execute(`${placeholderSelect} WHERE a.content IS NOT NULL ORDER BY a.id;`);
    return rows.filter((row) => isPlaceholderArticle(row.content));
  }

  async function deletePlaceholderArticles(ids) {
    const safeIds = Array.isArray(ids) ? ids.map(Number) : [];
    if (safeIds.length === 0 || safeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(safeIds).size !== safeIds.length) {
      throw new Error('placeholder article IDs must be unique positive integers');
    }

    const connection = await database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `
          ${placeholderSelect}
          WHERE a.id = ANY(?::bigint[])
          ORDER BY a.id
          FOR UPDATE OF a, c;
        `,
        [safeIds],
      );
      if (rows.length !== safeIds.length || rows.some((row) => !isPlaceholderArticle(row.content))) {
        throw new Error('Placeholder article set changed before deletion');
      }
      const candidateIds = rows.map((row) => Number(row.candidateId));
      const [deleteResult] = await connection.execute(
        `
          DELETE FROM article
          WHERE id = ANY(?::bigint[]);
        `,
        [safeIds],
      );
      if (deleteResult.affectedRows !== safeIds.length) throw new Error('Placeholder article deletion count changed');
      const [candidateResult] = await connection.execute(
        `
          UPDATE ingest_candidate
          SET status = 'rejected',
              failure_reason = 'Removed fixed-format placeholder article',
              updated_at = clock_timestamp()
          WHERE id = ANY(?::bigint[]);
        `,
        [candidateIds],
      );
      if (candidateResult.affectedRows !== candidateIds.length) throw new Error('Placeholder candidate update count changed');
      await connection.commit();
      return rows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  return {
    deletePlaceholderArticles,
    listPublishedCandidatesByIds,
    listRawCandidatesByIds,
    listPlaceholderArticles,
    publishRawArticle,
    replacePublishedArticle,
  };
}

module.exports = {
  createRichArticleRepository,
};
