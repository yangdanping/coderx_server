import type { MutationResult } from '../app/database/database.types.js';
import { MEDIA_VARIANT } from '../constants/mediaStorage.js';
import BusinessError from '../errors/BusinessError.js';
import { deriveFlowContent } from '../utils/flowContent.js';
import { isFlowRequestId } from '../utils/flowInput.js';
import { hydrateAvatarUrls } from '../utils/publicAssetUrls.js';
import type { FlowItem, FlowService as FlowServicePort, FlowServiceDependencies } from './flow.types.js';
import { DRAFT_TYPE, buildConsumeDraftSql } from './sql/draft.sql.js';
import {
  buildClearFlowDraftMediaSql,
  buildFindFlowByRequestIdSql,
  buildFlowDetailSql,
  buildFlowFeedSql,
  buildInsertFlowMediaSql,
  buildInsertFlowSql,
  buildLockActiveFlowDraftSql,
  buildLockFlowMediaSql,
  buildValidateFlowMediaSql,
} from './sql/flow.sql.js';

type FlowId = number | string;

interface FlowIdRow {
  id: FlowId;
}

interface FlowRow extends FlowIdRow {
  content: unknown;
  bodyText: string | null;
  createAt?: Date | string;
  author: unknown;
  media: unknown;
}

interface FlowPromotionImage extends FlowIdRow {
  filename: string;
  mimetype: string;
}

const MAX_MEDIA = 9;
const DRAFT_CONFLICT_MESSAGE = 'Flow 草稿已发生变更，请重新打开编辑器后再发布';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function positiveSafeInteger(value: unknown, name: string) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new BusinessError(`参数错误: ${name} 必须是正整数`, 400);
  }
  return normalized;
}

function validateCreateInput(input: unknown) {
  if (!isRecord(input)) {
    throw new BusinessError('参数错误: Flow 请求体必须是对象', 400);
  }
  if (!isFlowRequestId(input.clientRequestId)) {
    throw new BusinessError('参数错误: clientRequestId 必须是 UUID', 400);
  }
  if (!Array.isArray(input.mediaIds)) {
    throw new BusinessError('参数错误: mediaIds 必须是数组', 400);
  }
  if (input.mediaIds.length > MAX_MEDIA) {
    throw new BusinessError('Flow 最多只能包含 9 张图片', 400);
  }
  if (!input.mediaIds.every(isPositiveSafeInteger)) {
    throw new BusinessError('参数错误: mediaIds 只能包含正安全整数', 400);
  }
  if (new Set(input.mediaIds).size !== input.mediaIds.length) {
    throw new BusinessError('参数错误: mediaIds 不能重复', 400);
  }
  const draft = input.draft;
  if (
    draft !== null &&
    (!isRecord(draft) || !isPositiveSafeInteger(draft.id) || !isPositiveSafeInteger(draft.version))
  ) {
    throw new BusinessError('参数错误: draft 必须是 null 或包含正安全整数 id 和 version 的对象', 400);
  }
  const derived = deriveFlowContent(input.content);
  if (!derived.bodyText && input.mediaIds.length === 0) {
    throw new BusinessError('Flow 必须包含正文或图片', 400);
  }
  return {
    clientRequestId: input.clientRequestId,
    mediaIds: input.mediaIds.slice(),
    draft: draft === null ? null : { id: draft.id, version: draft.version },
    ...derived,
  };
}

function parseContent(value: unknown) {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return { type: 'doc', content: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { type: 'doc', content: [] };
  } catch {
    return { type: 'doc', content: [] };
  }
}

export class FlowService implements FlowServicePort {
  readonly database: FlowServiceDependencies['database'];
  readonly mediaRuntime: FlowServiceDependencies['mediaRuntime'];
  readonly logger: FlowServiceDependencies['logger'];
  readonly publicApiOrigin: string;

  constructor({ database: databaseDependency, mediaRuntime: mediaRuntimeDependency, logger, publicApiOrigin }: FlowServiceDependencies) {
    this.database = databaseDependency;
    this.mediaRuntime = mediaRuntimeDependency;
    this.logger = logger;
    this.publicApiOrigin = publicApiOrigin;
  }

  async hydrateFlow(row: FlowRow): Promise<FlowItem> {
    const content = parseContent(row?.content);
    const derived = deriveFlowContent(content);
    const rawAuthor = isRecord(row?.author) ? row.author : {};
    const name = typeof rawAuthor.name === 'string' ? rawAuthor.name : '';
    const author = {
      id: positiveSafeInteger(rawAuthor.id, 'author.id'),
      name: (typeof rawAuthor.nickname === 'string' && rawAuthor.nickname) || name,
      username: name,
      avatarUrl: typeof rawAuthor.avatarUrl === 'string' ? rawAuthor.avatarUrl : '',
    };
    hydrateAvatarUrls(author, this.publicApiOrigin);

    const rawMedia: unknown[] = Array.isArray(row?.media) ? row.media.slice() : [];
    const mediaRows = rawMedia.map((item) => (isRecord(item) ? item : {}));
    mediaRows.sort((left, right) => Number(left.position) - Number(right.position));
    const media = await Promise.all(
      mediaRows.map(async (item) => {
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

  async getFlowDetail(flowId: unknown) {
    const normalizedFlowId = positiveSafeInteger(flowId, 'flowId');
    const [rows] = await this.database.execute(buildFlowDetailSql(), [normalizedFlowId]);
    const row = (rows as FlowRow[])[0];
    if (!row) throw new BusinessError('Flow 不存在', 404);
    return this.hydrateFlow(row);
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
      items: await Promise.all((rows as FlowRow[]).map((row) => this.hydrateFlow(row))),
      total: Number((countRows as { total: number | string }[])[0]?.total || 0),
      page: normalizedPage,
      pageSize: normalizedPageSize,
    };
  }

  async promoteFlowImages(images: FlowPromotionImage[]) {
    try {
      const promotion = await this.mediaRuntime.promotePublishedImages({ images });
      if (isRecord(promotion) && Number(promotion.failed) > 0) {
        this.logger.error('Flow image promotion reported failures after commit:', promotion);
      }
    } catch (error) {
      this.logger.error('Flow image promotion failed after commit:', error);
    }
  }

  async loadFlowPromotionImages(flowId: FlowId) {
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
    return rows as FlowPromotionImage[];
  }

  async createFlow(userId: unknown, input: unknown) {
    const normalizedUserId = positiveSafeInteger(userId, 'userId');
    const normalized = validateCreateInput(input);
    const conn = await this.database.getConnection();
    let transactionActive = false;
    let flowId: number;
    let orderedImages: FlowPromotionImage[] = [];
    let idempotentConflict = false;

    try {
      await conn.beginTransaction();
      transactionActive = true;
      const [insertResult] = await conn.execute(buildInsertFlowSql(), [normalizedUserId, normalized.clientRequestId, JSON.stringify(normalized.content), normalized.bodyText]);
      flowId = Number((insertResult as Pick<MutationResult, 'insertId'> | null)?.insertId || 0);
      if (!Number.isSafeInteger(flowId) || flowId <= 0) {
        await conn.rollback();
        transactionActive = false;
        idempotentConflict = true;
      } else {
        let lockedDraftId = null;
        if (normalized.draft !== null) {
          const [activeDraftRows] = await conn.execute(buildLockActiveFlowDraftSql(), [normalized.draft.id, normalizedUserId]);
          const activeDraft = (activeDraftRows as (FlowIdRow & { version: number | string })[])[0];
          if (!activeDraft || Number(activeDraft.id) !== normalized.draft.id || Number(activeDraft.version) !== normalized.draft.version) {
            throw new BusinessError(DRAFT_CONFLICT_MESSAGE, 409);
          }
          lockedDraftId = normalized.draft.id;
        }

        if (normalized.mediaIds.length) {
          const lockSql = buildLockFlowMediaSql(normalized.mediaIds.length);
          const validateSql = buildValidateFlowMediaSql(normalized.mediaIds.length);
          if (!lockSql || !validateSql) throw new Error('invalid Flow media count');

          const [lockedResult] = await conn.execute(lockSql, [normalizedUserId, ...normalized.mediaIds]);
          const lockedRows = lockedResult as FlowIdRow[];
          const lockedIds = new Set(lockedRows.map((row) => Number(row.id)));
          if (lockedRows.length !== normalized.mediaIds.length || normalized.mediaIds.some((id) => !lockedIds.has(id))) {
            throw new BusinessError('图片不可用于此 Flow', 409);
          }

          const [validatedResult] = await conn.execute(validateSql, [normalizedUserId, lockedDraftId, ...normalized.mediaIds]);
          const validatedRows = validatedResult as FlowPromotionImage[];
          const validatedById = new Map(validatedRows.map((row) => [Number(row.id), row]));
          if (validatedRows.length !== normalized.mediaIds.length || normalized.mediaIds.some((id) => !validatedById.has(id))) {
            throw new BusinessError('图片不可用于此 Flow', 409);
          }

          orderedImages = normalized.mediaIds.map((id) => validatedById.get(id)!);
          if (lockedDraftId) {
            const clearMediaSql = buildClearFlowDraftMediaSql(orderedImages.length);
            if (!clearMediaSql) throw new Error('invalid Flow media count');
            await conn.execute(clearMediaSql, [lockedDraftId, ...normalized.mediaIds]);
          }
          const insertMediaSql = buildInsertFlowMediaSql(orderedImages.length);
          if (!insertMediaSql) throw new Error('invalid Flow media count');
          await conn.execute(
            insertMediaSql,
            orderedImages.flatMap((image, position) => [flowId, image.id, position]),
          );
        }

        if (lockedDraftId) {
          const [consumedRows] = await conn.execute(buildConsumeDraftSql(DRAFT_TYPE.FLOW), [lockedDraftId, normalizedUserId, null]);
          const consumedCount = Array.isArray(consumedRows) ? consumedRows.length : Number((consumedRows as Pick<MutationResult, 'affectedRows'> | null)?.affectedRows || 0);
          if (consumedCount !== 1) throw new BusinessError(DRAFT_CONFLICT_MESSAGE, 409);
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
      if (isRecord(error) && error.code === '23505') throw new BusinessError('图片不可用于此 Flow', 409);
      throw error;
    } finally {
      conn.release();
    }

    if (idempotentConflict) {
      const [existingRows] = await this.database.execute(buildFindFlowByRequestIdSql(), [normalizedUserId, normalized.clientRequestId]);
      const existingFlow = (existingRows as FlowIdRow[])[0];
      if (!existingFlow) throw new Error('idempotent Flow insert returned no id and no existing row');
      await this.promoteFlowImages(await this.loadFlowPromotionImages(existingFlow.id));
      return this.getFlowDetail(existingFlow.id);
    }

    await this.promoteFlowImages(orderedImages);
    return this.getFlowDetail(flowId);
  }
}

export function createFlowService(dependencies: FlowServiceDependencies): FlowServicePort {
  return new FlowService(dependencies);
}
