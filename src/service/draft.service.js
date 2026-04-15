const connection = require('@/app/database');
const { baseURL } = require('@/constants/urls');
const BusinessError = require('@/errors/BusinessError');
const {
  collectMediaRefs,
  hydrateStructuredContentMediaSources,
  resolveStructuredArticleContent,
} = require('@/utils/articleContent');
const { buildPublicAssetUrl } = require('@/utils/publicAssetUrls');
const {
  buildUpsertDraftSql,
  buildFindDraftSql,
  buildCheckOwnedArticleSql,
  buildValidateDraftFilesSql,
  buildClearRemovedDraftFilesSql,
  buildBindDraftFilesSql,
  buildDiscardDraftSql,
} = require('./sql/draft.sql');

function normalizeFileIds(meta = {}) {
  const candidates = [];

  if (Array.isArray(meta.imageIds)) candidates.push(...meta.imageIds);
  if (Array.isArray(meta.videoIds)) candidates.push(...meta.videoIds);
  if (meta.coverImageId !== undefined && meta.coverImageId !== null) candidates.push(meta.coverImageId);

  return Array.from(new Set(candidates.map((id) => normalizePositiveId(id)).filter((id) => id !== null)));
}

function normalizeNonNegativeInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) ? normalized : null;
  }

  return null;
}

function normalizePositiveId(id) {
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) {
    const normalized = Number(id);
    return Number.isSafeInteger(normalized) ? normalized : null;
  }

  return null;
}

function normalizeIdList(ids) {
  if (!Array.isArray(ids)) {
    return [];
  }

  return Array.from(new Set(ids.map((id) => normalizePositiveId(id)).filter((id) => id !== null)));
}

function normalizeDraftMeta(meta = {}) {
  const normalizedMeta = { ...meta };

  if (Object.prototype.hasOwnProperty.call(meta, 'imageIds')) {
    normalizedMeta.imageIds = normalizeIdList(meta.imageIds);
  }

  if (Object.prototype.hasOwnProperty.call(meta, 'videoIds')) {
    normalizedMeta.videoIds = normalizeIdList(meta.videoIds);
  }

  if (meta.coverImageId !== undefined && meta.coverImageId !== null) {
    const normalizedCoverImageId = normalizePositiveId(meta.coverImageId);
    if (normalizedCoverImageId === null) {
      delete normalizedMeta.coverImageId;
    } else {
      normalizedMeta.coverImageId = normalizedCoverImageId;
    }
  }

  return normalizedMeta;
}

function buildImageLookupByRows(rows = []) {
  return rows.reduce((lookup, row) => {
    const imageId = normalizePositiveId(row?.id);
    const filename = typeof row?.filename === 'string' ? row.filename.trim() : '';
    const fileType = typeof row?.file_type === 'string' ? row.file_type : null;
    if (imageId && filename && (fileType === 'image' || fileType === null)) {
      lookup[imageId] = { url: buildPublicAssetUrl(baseURL, `/article/images/${filename}`) };
    }
    return lookup;
  }, {});
}

function buildVideoLookupByRows(fileRows = [], videoMetaRows = []) {
  const posterByFileId = videoMetaRows.reduce((lookup, row) => {
    const fileId = normalizePositiveId(row?.file_id);
    const poster = typeof row?.poster === 'string' && row.poster.trim() ? row.poster.trim() : '';
    if (fileId && poster) {
      lookup[fileId] = poster;
    }
    return lookup;
  }, {});

  return fileRows.reduce((lookup, row) => {
    const videoId = normalizePositiveId(row?.id);
    const filename = typeof row?.filename === 'string' ? row.filename.trim() : '';
    if (videoId && filename && row?.file_type === 'video') {
      lookup[videoId] = {
        url: buildPublicAssetUrl(baseURL, `/article/video/${filename}`),
        poster: posterByFileId[videoId] ? buildPublicAssetUrl(baseURL, `/article/video/${posterByFileId[videoId]}`) : null,
      };
    }
    return lookup;
  }, {});
}

async function hydrateDraftContentMedia(executor, draft) {
  const structuredContent = resolveStructuredArticleContent(draft?.content, null);
  if (!structuredContent) {
    return draft;
  }

  const mediaRefs = collectMediaRefs(structuredContent);
  const fileIds = Array.from(new Set([...mediaRefs.imageIds, ...mediaRefs.videoIds]));
  if (!fileIds.length) {
    return draft;
  }

  const [fileRows] = await executor.execute(
    `
      SELECT id, filename, file_type
      FROM file
      WHERE id = ANY($1::bigint[])
      ORDER BY id ASC;
    `,
    [fileIds],
  );
  const videoFileIds = fileRows
    .filter((row) => row?.file_type === 'video')
    .map((row) => normalizePositiveId(row?.id))
    .filter((id) => id !== null);
  let videoMetaRows = [];

  if (videoFileIds.length) {
    [videoMetaRows] = await executor.execute(
      `
        SELECT file_id, poster
        FROM video_meta
        WHERE file_id = ANY($1::bigint[]);
      `,
      [videoFileIds],
    );
  }

  draft.content = hydrateStructuredContentMediaSources(structuredContent, {
    imagesById: buildImageLookupByRows(fileRows),
    videosById: buildVideoLookupByRows(fileRows, videoMetaRows),
  });
  return draft;
}

async function ensureOwnedArticle(executor, articleId, userId) {
  const [rows] = await executor.execute(buildCheckOwnedArticleSql(), [articleId, userId]);
  if (!rows[0]) {
    throw new BusinessError('文章不存在或无权限', 404);
  }
}

class DraftService {
  upsertDraft = async (userId, payload) => {
    const normalizedArticleId = payload.articleId === null || payload.articleId === undefined ? null : normalizePositiveId(payload.articleId);
    if (payload.articleId !== null && payload.articleId !== undefined && normalizedArticleId === null) {
      throw new BusinessError('参数错误: articleId 必须是正整数', 400);
    }

    const normalizedVersion = normalizeNonNegativeInt(payload.version ?? 0);
    if (normalizedVersion === null) {
      throw new BusinessError('参数错误: version 必须是非负整数', 400);
    }

    const hasArticleId = normalizedArticleId !== null;
    const meta = normalizeDraftMeta(payload.meta ?? {});
    const fileIds = normalizeFileIds(meta);
    const conn = await connection.getConnection();

    try {
      await conn.beginTransaction();

      if (hasArticleId) {
        await ensureOwnedArticle(conn, normalizedArticleId, userId);
      }

      const [upsertResult] = await conn.execute(buildUpsertDraftSql({ hasArticleId }), [
        userId,
        normalizedArticleId,
        payload.title ?? null,
        JSON.stringify(payload.content),
        JSON.stringify(meta),
        normalizedVersion,
      ]);

      if (!upsertResult.affectedRows) {
        throw new BusinessError('草稿版本冲突', 409);
      }

      const findParams = hasArticleId ? [userId, normalizedArticleId] : [userId];
      const [draftRows] = await conn.execute(buildFindDraftSql({ hasArticleId }), findParams);
      const draft = draftRows[0];

      if (!draft) {
        throw new Error('草稿保存后读取失败');
      }

      const [validRows] = await conn.execute(buildValidateDraftFilesSql(), [
        userId,
        fileIds,
        normalizedArticleId,
        draft.id,
      ]);

      if (validRows.length !== fileIds.length) {
        throw new BusinessError('草稿引用了无效文件', 400);
      }

      await conn.execute(buildClearRemovedDraftFilesSql(), [userId, draft.id, fileIds]);

      if (fileIds.length > 0) {
        await conn.execute(buildBindDraftFilesSql(), [userId, draft.id, fileIds]);
      }

      await hydrateDraftContentMedia(conn, draft);
      await conn.commit();
      return draft;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  };

  getDraft = async (userId, articleId = null) => {
    const normalizedArticleId = articleId === null || articleId === undefined ? null : normalizePositiveId(articleId);
    if (articleId !== null && articleId !== undefined && normalizedArticleId === null) {
      throw new BusinessError('参数错误: articleId 必须是正整数', 400);
    }

    const hasArticleId = normalizedArticleId !== null;

    if (hasArticleId) {
      await ensureOwnedArticle(connection, normalizedArticleId, userId);
    }

    const [rows] = await connection.execute(buildFindDraftSql({ hasArticleId }), hasArticleId ? [userId, normalizedArticleId] : [userId]);
    if (!rows[0]) {
      return null;
    }

    return hydrateDraftContentMedia(connection, rows[0]);
  };

  deleteDraft = async (userId, draftId) => {
    const normalizedDraftId = normalizePositiveId(draftId);
    if (normalizedDraftId === null) {
      throw new BusinessError('参数错误: draftId 必须是正整数', 400);
    }

    const conn = await connection.getConnection();

    try {
      await conn.beginTransaction();

      const [result] = await conn.execute(buildDiscardDraftSql(), [normalizedDraftId, userId]);

      if (!result.affectedRows) {
        throw new BusinessError('草稿不存在', 404);
      }

      await conn.execute(buildClearRemovedDraftFilesSql(), [userId, normalizedDraftId, []]);
      await conn.commit();
      return { id: normalizedDraftId };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  };
}

module.exports = new DraftService();
