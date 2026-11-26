import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { FlowService } from '../service/flow.types.js';
import { isFlowRequestId } from '../utils/flowInput.js';
import { parseDraftInteger, structuredObject } from '../http/articleDraftInput.js';
import { bodyFields, queryValue } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: detailHandlers } = createFactory<AppEnv, '/flow/:flowId{[1-9][0-9]*}'>();

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseDraftReference(value: unknown) {
  if (value === null) return null;
  const draft = structuredObject.safeParse(value);
  if (!draft.success) return undefined;
  const { id, version } = draft.data;
  if (!isPositiveSafeInteger(id) || !isPositiveSafeInteger(version)) return undefined;
  return { id, version };
}

export function createFlowController(service: FlowService) {
  return {
    createFlow: createHandlers(async c => {
      const { clientRequestId, content, mediaIds, draft } = bodyFields(c.get('parsedBody'));
      if (!isFlowRequestId(clientRequestId)) return legacyJson(c, Result.fail('参数错误: clientRequestId 必须是 UUID'));
      const parsedContent = structuredObject.safeParse(content);
      if (!parsedContent.success || parsedContent.data.type !== 'doc') {
        return legacyJson(c, Result.fail('参数错误: content 必须是 Tiptap doc'));
      }
      if (!Array.isArray(mediaIds)) return legacyJson(c, Result.fail('参数错误: mediaIds 必须是数组'));
      if (mediaIds.length > 9) return legacyJson(c, Result.fail('参数错误: mediaIds 不能超过 9 个'));
      if (!mediaIds.every(isPositiveSafeInteger)) return legacyJson(c, Result.fail('参数错误: mediaIds 只能包含正安全整数'));
      if (new Set(mediaIds).size !== mediaIds.length) return legacyJson(c, Result.fail('参数错误: mediaIds 不能重复'));
      const reference = parseDraftReference(draft);
      if (reference === undefined) return legacyJson(c, Result.fail('参数错误: draft 必须是 null 或包含正安全整数 id 和 version 的对象'));

      return legacyJson(c, Result.success(await service.createFlow(authUserId(c.get('user')), {
        clientRequestId, content: parsedContent.data, mediaIds, draft: reference,
      })));
    }),
    getFlowFeed: createHandlers(async c => {
      const search = new URL(c.req.url).searchParams;
      const page = parseDraftInteger(queryValue(search, 'pageNum') ?? 1, 1);
      const pageSize = parseDraftInteger(queryValue(search, 'pageSize') ?? 10, 1);
      if (page === null || pageSize === null || pageSize > 100) {
        return legacyJson(c, Result.fail('参数错误: 分页参数必须是有效正整数，且 pageSize 不能超过 100'));
      }
      return legacyJson(c, Result.success(await service.getFlowFeed(page, pageSize)));
    }),
    getFlowDetail: detailHandlers(async c => {
      const flowId = parseDraftInteger(c.req.param('flowId'), 1);
      if (flowId === null) return legacyJson(c, Result.fail('参数错误: flowId 必须是正整数'));
      return legacyJson(c, Result.success(await service.getFlowDetail(flowId)));
    }),
  };
}
