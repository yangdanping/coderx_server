import type { MutationResult, QueryExecutor } from '../app/database/database.types.js';
import { MEDIA_VARIANT } from '../constants/mediaStorage.js';
import BusinessError from '../errors/BusinessError.js';
import { collectMediaRefs, hydrateStructuredContentMediaSources, resolveStructuredArticleContent } from '../utils/articleContent.js';
import { buildPublicAssetUrl } from '../utils/publicAssetUrls.js';
import type { DraftPayload, DraftService as DraftServicePort, DraftServiceDependencies } from './article/article.types.js';
import type { FlowDraft, FlowDraftPayload, FlowDraftService } from './flow.types.js';
import {
  DRAFT_TYPE,
  buildUpsertDraftSql,
  buildFindDraftSql,
  buildCheckOwnedArticleSql,
  buildFindDraftFileIdsSql,
  buildLockDraftFilesSql,
  buildValidateDraftFilesSql,
  buildClearRemovedDraftFilesSql,
  buildBindDraftFilesSql,
  buildDiscardDraftSql,
  type DraftType,
} from './sql/draft.sql.js';

interface DraftRow {
  id: number;
  userId: number;
  draftType: DraftType;
  articleId: number | null;
  title: string | null;
  content: unknown;
  meta: unknown;
  version: number;
  createAt: Date | string;
  updateAt: Date | string;
}

interface DraftFileRow {
  id: number;
  filename: string;
  file_type: 'image' | 'video' | null;
}

interface DraftVideoMetaRow {
  file_id: number;
  poster: string | null;
}

interface FlowDraftImageRow {
  id: number;
  filename: string;
  mimetype: string;
  size: number | string;
  width: number | string;
  height: number | string;
}

interface DraftByType {
  article: DraftRow;
  flow: FlowDraft;
}

export function createDraftService({ connection, baseURL, mediaRuntime }: DraftServiceDependencies) {
  function normalizeFileIds(meta: Record<string, unknown> = {}) {
    const candidates: unknown[] = [];

    if (Array.isArray(meta.imageIds)) candidates.push(...meta.imageIds);
    if (Array.isArray(meta.videoIds)) candidates.push(...meta.videoIds);
    if (meta.coverImageId !== undefined && meta.coverImageId !== null) candidates.push(meta.coverImageId);

    return Array.from(new Set(candidates.map((id) => normalizePositiveId(id)).filter((id) => id !== null)));
  }

  function normalizeNonNegativeInt(value: unknown) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
      const normalized = Number(value);
      return Number.isSafeInteger(normalized) ? normalized : null;
    }

    return null;
  }

  function normalizePositiveId(id: unknown) {
    if (typeof id === 'number') {
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) {
      const normalized = Number(id);
      return Number.isSafeInteger(normalized) ? normalized : null;
    }

    return null;
  }

  function normalizeIdList(ids: unknown) {
    if (!Array.isArray(ids)) {
      return [];
    }

    return Array.from(new Set(ids.map(normalizePositiveId).filter((id) => id !== null)));
  }

  function normalizeDraftMeta(meta: Record<string, unknown> = {}) {
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

  async function buildImageLookupByRows(rows: DraftFileRow[] = []) {
    const lookup: Partial<Record<number, { url: string }>> = {};
    await Promise.all(
      rows.map(async (row) => {
        const imageId = normalizePositiveId(row?.id);
        const filename = typeof row?.filename === 'string' ? row.filename.trim() : '';
        const fileType = typeof row?.file_type === 'string' ? row.file_type : null;
        if (imageId && filename && (fileType === 'image' || fileType === null)) {
          const resolvedUrl = await mediaRuntime.resolveImageUrl(imageId, {
            variant: MEDIA_VARIANT.ORIGINAL,
          });
          lookup[imageId] = {
            url: resolvedUrl || buildPublicAssetUrl(baseURL, `/article/images/${filename}`),
          };
        }
      }),
    );
    return lookup;
  }

  function buildVideoLookupByRows(fileRows: DraftFileRow[] = [], videoMetaRows: DraftVideoMetaRow[] = []) {
    const posterByFileId = videoMetaRows.reduce<Partial<Record<number, string>>>((lookup, row) => {
      const fileId = normalizePositiveId(row?.file_id);
      const poster = typeof row?.poster === 'string' && row.poster.trim() ? row.poster.trim() : '';
      if (fileId && poster) {
        lookup[fileId] = poster;
      }
      return lookup;
    }, {});

    return fileRows.reduce<Partial<Record<number, { url: string; poster: string | null }>>>((lookup, row) => {
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

  async function hydrateDraftContentMedia(executor: QueryExecutor, draft: DraftRow) {
    const structuredContent = resolveStructuredArticleContent(draft?.content, null);
    if (!structuredContent) {
      return draft;
    }

    const mediaRefs = collectMediaRefs(structuredContent);
    const fileIds = Array.from(new Set([...mediaRefs.imageIds, ...mediaRefs.videoIds]));
    if (!fileIds.length) {
      return draft;
    }

    const [fileResult] = await executor.execute(
      `
        SELECT id, filename, file_type
        FROM file
        WHERE id = ANY($1::bigint[])
        ORDER BY id ASC;
      `,
      [fileIds],
    );
    const fileRows = fileResult as DraftFileRow[];
    const videoFileIds = fileRows
      .filter((row) => row?.file_type === 'video')
      .map((row) => normalizePositiveId(row?.id))
      .filter((id) => id !== null);
    let videoMetaRows: DraftVideoMetaRow[] = [];

    if (videoFileIds.length) {
      const [videoMetaResult] = await executor.execute(
        `
          SELECT file_id, poster
          FROM video_meta
          WHERE file_id = ANY($1::bigint[]);
        `,
        [videoFileIds],
      );
      videoMetaRows = videoMetaResult as DraftVideoMetaRow[];
    }

    draft.content = hydrateStructuredContentMediaSources(structuredContent, {
      imagesById: await buildImageLookupByRows(fileRows),
      videosById: buildVideoLookupByRows(fileRows, videoMetaRows),
    });
    return draft;
  }

  async function hydrateFlowDraftImages(executor: QueryExecutor, draft: DraftRow) {
    const meta = draft?.meta;
    const imageIds = normalizeIdList(meta && typeof meta === 'object' && 'imageIds' in meta ? meta.imageIds : undefined);
    if (imageIds.length === 0) {
      return { ...draft, images: [] };
    }

    const [imageResult] = await executor.execute(
      `
        SELECT f.id, f.filename, f.mimetype, f.size, im.width, im.height
        FROM file f
        INNER JOIN image_meta im ON im.file_id = f.id
        WHERE f.user_id = $1
          AND f.draft_id = $2
          AND f.id = ANY($3::bigint[])
          AND f.file_type = 'image'
          AND NOT EXISTS (
            SELECT 1 FROM flow_post_media fm WHERE fm.file_id = f.id
          );
      `,
      [draft.userId, draft.id, imageIds],
    );
    const rows = imageResult as FlowDraftImageRow[];
    if (rows.length !== imageIds.length) {
      throw new BusinessError('Flow 草稿图片无法完整恢复', 409);
    }

    const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
    const images = await Promise.all(
      imageIds.map(async (id) => {
        const row = rowsById.get(id)!;
        const [url, thumbnailUrl] = await Promise.all([
          mediaRuntime.resolveImageUrl(id, { variant: MEDIA_VARIANT.ORIGINAL }),
          mediaRuntime.resolveImageUrl(id, { variant: MEDIA_VARIANT.SMALL }),
        ]);
        return {
          id,
          url: url || buildPublicAssetUrl(baseURL, `/article/images/${row.filename}`),
          thumbnailUrl: thumbnailUrl || buildPublicAssetUrl(baseURL, `/article/images/${row.filename}?type=small`),
          mimeType: row.mimetype,
          sizeBytes: Number(row.size),
          width: Number(row.width),
          height: Number(row.height),
        };
      }),
    );
    return { ...draft, images };
  }

  async function hydrateDraftByType<Kind extends DraftType>(executor: QueryExecutor, draft: DraftRow, draftType: Kind): Promise<DraftByType[Kind]> {
    await hydrateDraftContentMedia(executor, draft);
    const hydrated = draftType === DRAFT_TYPE.FLOW ? await hydrateFlowDraftImages(executor, draft) : draft;
    // The SELECT is scoped to draftType and the Flow branch adds its image data.
    return hydrated as DraftByType[Kind];
  }

  async function ensureOwnedArticle(executor: QueryExecutor, articleId: number, userId: unknown) {
    const [rows] = await executor.execute(buildCheckOwnedArticleSql(), [articleId, userId]);
    if (!(rows as { id: number }[])[0]) {
      throw new BusinessError('文章不存在或无权限', 404);
    }
  }

  class DraftService implements DraftServicePort, FlowDraftService {
    upsertDraft = async (userId: unknown, payload: DraftPayload) => this.upsertDraftByType(userId, payload, DRAFT_TYPE.ARTICLE);

    upsertFlowDraft = async (userId: unknown, payload: FlowDraftPayload) =>
      this.upsertDraftByType(
        userId,
        {
          ...payload,
          articleId: null,
          title: null,
        },
        DRAFT_TYPE.FLOW,
      );

    upsertDraftByType = async <Kind extends DraftType>(userId: unknown, payload: DraftPayload, draftType: Kind) => {
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

        const [upsertResult] = await conn.execute(buildUpsertDraftSql({ hasArticleId, draftType }), [
          userId,
          normalizedArticleId,
          payload.title ?? null,
          JSON.stringify(payload.content),
          JSON.stringify(meta),
          normalizedVersion,
        ]);

        if (!(upsertResult as Pick<MutationResult, 'affectedRows'>).affectedRows) {
          throw new BusinessError('草稿版本冲突', 409);
        }

        const findParams = hasArticleId ? [userId, normalizedArticleId] : [userId];
        const [draftRows] = await conn.execute(buildFindDraftSql({ hasArticleId, draftType }), findParams);
        const draft = (draftRows as DraftRow[])[0];

        if (!draft) {
          throw new Error('草稿保存后读取失败');
        }

        const [currentFileRows] = await conn.execute(buildFindDraftFileIdsSql(), [userId, draft.id]);
        const lockIds = Array.from(new Set([...(currentFileRows as Pick<DraftFileRow, 'id'>[]).map((row) => normalizePositiveId(row.id)).filter((id) => id !== null), ...fileIds])).sort(
          (left, right) => left - right,
        );

        if (lockIds.length > 0) {
          const [lockedRows] = await conn.execute(buildLockDraftFilesSql(), [userId, lockIds]);
          if ((lockedRows as Pick<DraftFileRow, 'id'>[]).length !== lockIds.length) {
            throw new BusinessError('草稿引用了无效文件', 400);
          }
        }

        if (fileIds.length > 0) {
          const [validRows] = await conn.execute(buildValidateDraftFilesSql(), [userId, fileIds, normalizedArticleId, draft.id]);
          if ((validRows as Pick<DraftFileRow, 'id'>[]).length !== fileIds.length) {
            throw new BusinessError('草稿引用的文件已被关联', 409);
          }
        }

        await conn.execute(buildClearRemovedDraftFilesSql(), [userId, draft.id, fileIds]);

        if (fileIds.length > 0) {
          const [bindResult] = await conn.execute(buildBindDraftFilesSql(), [userId, draft.id, fileIds, normalizedArticleId]);
          if (Number((bindResult as Pick<MutationResult, 'affectedRows'> | null)?.affectedRows || 0) !== fileIds.length) {
            throw new BusinessError('草稿引用的文件已被关联', 409);
          }
        }

        const hydratedDraft = await hydrateDraftByType(conn, draft, draftType);
        await conn.commit();
        return hydratedDraft;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    };

    getDraft = async (userId: unknown, articleId: unknown = null) => this.getDraftByType(userId, articleId, DRAFT_TYPE.ARTICLE);

    getFlowDraft = async (userId: unknown) => this.getDraftByType(userId, null, DRAFT_TYPE.FLOW);

    getDraftByType = async <Kind extends DraftType>(userId: unknown, articleId: unknown, draftType: Kind) => {
      const normalizedArticleId = articleId === null || articleId === undefined ? null : normalizePositiveId(articleId);
      if (articleId !== null && articleId !== undefined && normalizedArticleId === null) {
        throw new BusinessError('参数错误: articleId 必须是正整数', 400);
      }

      const hasArticleId = normalizedArticleId !== null;

      if (hasArticleId) {
        await ensureOwnedArticle(connection, normalizedArticleId, userId);
      }

      const [rows] = await connection.execute(buildFindDraftSql({ hasArticleId, draftType }), hasArticleId ? [userId, normalizedArticleId] : [userId]);
      const draft = (rows as DraftRow[])[0];
      return draft ? hydrateDraftByType(connection, draft, draftType) : null;
    };

    deleteDraft = async (userId: unknown, draftId: unknown) => this.deleteDraftByType(userId, draftId, DRAFT_TYPE.ARTICLE);

    deleteFlowDraft = async (userId: unknown, draftId: unknown) => this.deleteDraftByType(userId, draftId, DRAFT_TYPE.FLOW);

    deleteDraftByType = async (userId: unknown, draftId: unknown, draftType: DraftType) => {
      const normalizedDraftId = normalizePositiveId(draftId);
      if (normalizedDraftId === null) {
        throw new BusinessError('参数错误: draftId 必须是正整数', 400);
      }

      const conn = await connection.getConnection();

      try {
        await conn.beginTransaction();

        const [result] = await conn.execute(buildDiscardDraftSql(draftType), [normalizedDraftId, userId]);

        if (!(result as Pick<MutationResult, 'affectedRows'>).affectedRows) {
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
  return new DraftService();
}
