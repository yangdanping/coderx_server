const validator = require('validator');
const database = require('@/app/database');
const { baseURL } = require('@/constants/urls');
const { MEDIA_VARIANT } = require('@/constants/mediaStorage');
const BusinessError = require('@/errors/BusinessError');
const mediaRuntime = require('@/service/mediaRuntime.service');
const { deriveFlowContent } = require('@/utils/flowContent');
const { hydrateAvatarUrls } = require('@/utils/publicAssetUrls');
const { DRAFT_TYPE, buildConsumeDraftSql } = require('./sql/draft.sql');
const {
  buildClearFlowDraftMediaSql,
  buildFindFlowByRequestIdSql,
  buildFlowDetailSql,
  buildFlowFeedSql,
  buildInsertFlowMediaSql,
  buildInsertFlowSql,
  buildLockActiveFlowDraftSql,
  buildLockFlowMediaSql,
  buildValidateFlowMediaSql,
} = require('./sql/flow.sql');

const MAX_MEDIA = 9;

function positiveSafeInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new BusinessError(`参数错误: ${name} 必须是正整数`, 400);
  }
  return normalized;
}

function validateCreateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BusinessError('参数错误: Flow 请求体必须是对象', 400);
  }
  if (typeof input.clientRequestId !== 'string' || !validator.isUUID(input.clientRequestId)) {
    throw new BusinessError('参数错误: clientRequestId 必须是 UUID', 400);
  }
  if (!Array.isArray(input.mediaIds)) {
    throw new BusinessError('参数错误: mediaIds 必须是数组', 400);
  }
  if (input.mediaIds.length > MAX_MEDIA) {
    throw new BusinessError('Flow 最多只能包含 9 张图片', 400);
  }
  if (!input.mediaIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    throw new BusinessError('参数错误: mediaIds 只能包含正安全整数', 400);
  }
  if (new Set(input.mediaIds).size !== input.mediaIds.length) {
    throw new BusinessError('参数错误: mediaIds 不能重复', 400);
  }
  const derived = deriveFlowContent(input.content);
  if (!derived.bodyText && input.mediaIds.length === 0) {
    throw new BusinessError('Flow 必须包含正文或图片', 400);
  }
  return {
    clientRequestId: input.clientRequestId,
    mediaIds: input.mediaIds.slice(),
    ...derived,
  };
}

function parseContent(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return { type: 'doc', content: [] };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { type: 'doc', content: [] };
  } catch {
    return { type: 'doc', content: [] };
  }
}

class FlowService {
  constructor({ database: databaseDependency, mediaRuntime: mediaRuntimeDependency, logger, publicApiOrigin }) {
    this.database = databaseDependency;
    this.mediaRuntime = mediaRuntimeDependency;
    this.logger = logger;
    this.publicApiOrigin = publicApiOrigin;
  }

  async hydrateFlow(row) {
    const content = parseContent(row?.content);
    const derived = deriveFlowContent(content);
    const rawAuthor = row?.author && typeof row.author === 'object' ? row.author : {};
    const author = {
      id: positiveSafeInteger(rawAuthor.id, 'author.id'),
      name: rawAuthor.nickname || rawAuthor.name || '',
      username: rawAuthor.name || '',
      avatarUrl: rawAuthor.avatarUrl || '',
    };
    hydrateAvatarUrls(author, this.publicApiOrigin);

    const rawMedia = Array.isArray(row?.media) ? row.media.slice() : [];
    rawMedia.sort((left, right) => Number(left.position) - Number(right.position));
    const media = await Promise.all(
      rawMedia.map(async (item) => {
        const id = positiveSafeInteger(item.id, 'media.id');
        const [url, smallUrl] = await Promise.all([
          this.mediaRuntime.resolveImageUrl(id, { variant: MEDIA_VARIANT.ORIGINAL }),
          this.mediaRuntime.resolveImageUrl(id, { variant: MEDIA_VARIANT.SMALL }),
        ]);
        return {
          id,
          url: url || '',
          thumbnailUrl: smallUrl || url || '',
          title: typeof item.altText === 'string' ? item.altText : '',
        };
      }),
    );

    return {
      id: positiveSafeInteger(row.id, 'flow.id'),
      author,
      body: typeof row.bodyText === 'string' ? row.bodyText : derived.bodyText,
      bodyHtml: derived.bodyHtml,
      media,
      likes: 0,
      comments: 0,
      liked: false,
      createdAt: row.createAt,
    };
  }

  async getFlowDetail(flowId) {
    const normalizedFlowId = positiveSafeInteger(flowId, 'flowId');
    const [rows] = await this.database.execute(buildFlowDetailSql(), [normalizedFlowId]);
    if (!rows[0]) throw new BusinessError('Flow 不存在', 404);
    return this.hydrateFlow(rows[0]);
  }

  async getFlowFeed(page = 1, pageSize = 10) {
    const normalizedPage = positiveSafeInteger(page, 'page');
    const normalizedPageSize = positiveSafeInteger(pageSize, 'pageSize');
    if (normalizedPageSize > 100) throw new BusinessError('参数错误: pageSize 不能超过 100', 400);
    const offset = (normalizedPage - 1) * normalizedPageSize;
    if (!Number.isSafeInteger(offset)) throw new BusinessError('参数错误: 分页范围无效', 400);
    const [[rows], [countRows]] = await Promise.all([
      this.database.execute(buildFlowFeedSql(), [normalizedPageSize, offset]),
      this.database.execute('SELECT COUNT(*)::int AS total FROM flow_post;'),
    ]);
    return {
      items: await Promise.all(rows.map((row) => this.hydrateFlow(row))),
      total: Number(countRows[0]?.total || 0),
      page: normalizedPage,
      pageSize: normalizedPageSize,
    };
  }

  async promoteFlowImages(images) {
    try {
      const promotion = await this.mediaRuntime.promotePublishedImages({ images });
      if (Number(promotion?.failed) > 0) {
        this.logger.error('Flow image promotion reported failures after commit:', promotion);
      }
    } catch (error) {
      this.logger.error('Flow image promotion failed after commit:', error);
    }
  }

  async loadFlowPromotionImages(flowId) {
    const [rows] = await this.database.execute(
      `
        SELECT f.id, f.filename, f.mimetype
        FROM flow_post_media fm
        INNER JOIN file f ON f.id = fm.file_id
        WHERE fm.flow_id = ?
        ORDER BY fm.position ASC;
      `,
      [flowId],
    );
    return rows;
  }

  async createFlow(userId, input) {
    const normalizedUserId = positiveSafeInteger(userId, 'userId');
    const normalized = validateCreateInput(input);
    const conn = await this.database.getConnection();
    let transactionActive = false;
    let flowId = null;
    let orderedImages = [];
    let idempotentConflict = false;

    try {
      await conn.beginTransaction();
      transactionActive = true;
      const [insertResult] = await conn.execute(buildInsertFlowSql(), [normalizedUserId, normalized.clientRequestId, JSON.stringify(normalized.content), normalized.bodyText]);
      flowId = Number(insertResult?.insertId || 0);
      if (!Number.isSafeInteger(flowId) || flowId <= 0) {
        await conn.rollback();
        transactionActive = false;
        idempotentConflict = true;
      } else {
        const [activeDraftRows] = await conn.execute(buildLockActiveFlowDraftSql(), [normalizedUserId]);
        const lockedDraftId = activeDraftRows[0] ? positiveSafeInteger(activeDraftRows[0].id, 'draft.id') : null;

        if (normalized.mediaIds.length) {
          const [lockedRows] = await conn.execute(buildLockFlowMediaSql(normalized.mediaIds.length), normalized.mediaIds);
          const lockedIds = new Set(lockedRows.map((row) => Number(row.id)));
          if (lockedRows.length !== normalized.mediaIds.length || normalized.mediaIds.some((id) => !lockedIds.has(id))) {
            throw new BusinessError('图片不可用于此 Flow', 409);
          }

          const [validatedRows] = await conn.execute(buildValidateFlowMediaSql(normalized.mediaIds.length), [normalizedUserId, lockedDraftId, ...normalized.mediaIds]);
          const validatedById = new Map(validatedRows.map((row) => [Number(row.id), row]));
          if (validatedRows.length !== normalized.mediaIds.length || normalized.mediaIds.some((id) => !validatedById.has(id))) {
            throw new BusinessError('图片不可用于此 Flow', 409);
          }

          orderedImages = normalized.mediaIds.map((id) => validatedById.get(id));
          if (lockedDraftId) {
            await conn.execute(buildClearFlowDraftMediaSql(orderedImages.length), [lockedDraftId, ...normalized.mediaIds]);
          }
          await conn.execute(
            buildInsertFlowMediaSql(orderedImages.length),
            orderedImages.flatMap((image, position) => [flowId, image.id, position]),
          );
        }

        if (lockedDraftId) {
          const [consumedRows] = await conn.execute(buildConsumeDraftSql(DRAFT_TYPE.FLOW), [lockedDraftId, normalizedUserId, null]);
          const consumedCount = Array.isArray(consumedRows) ? consumedRows.length : Number(consumedRows?.affectedRows || 0);
          if (consumedCount !== 1) throw new BusinessError('Flow 草稿已发生变更', 409);
        }
        await conn.commit();
        transactionActive = false;
      }
    } catch (error) {
      if (transactionActive) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          this.logger.error('Flow transaction rollback failed:', rollbackError);
        }
      }
      if (error?.code === '23505') throw new BusinessError('图片不可用于此 Flow', 409);
      throw error;
    } finally {
      conn.release();
    }

    if (idempotentConflict) {
      const [existingRows] = await this.database.execute(buildFindFlowByRequestIdSql(), [normalizedUserId, normalized.clientRequestId]);
      if (!existingRows[0]) throw new Error('idempotent Flow insert returned no id and no existing row');
      await this.promoteFlowImages(await this.loadFlowPromotionImages(existingRows[0].id));
      return this.getFlowDetail(existingRows[0].id);
    }

    await this.promoteFlowImages(orderedImages);
    return this.getFlowDetail(flowId);
  }
}

function createFlowService(options = {}) {
  return new FlowService({
    database: options.database || database,
    mediaRuntime: options.mediaRuntime || mediaRuntime,
    logger: options.logger || console,
    publicApiOrigin: options.publicApiOrigin || baseURL,
  });
}

const flowService = createFlowService();

module.exports = Object.assign(flowService, {
  FlowService,
  createFlowService,
});
