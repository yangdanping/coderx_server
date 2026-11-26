import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { FlowDraftService } from '../service/flow.types.js';
import { parseDraftInteger, structuredObject } from '../http/articleDraftInput.js';
import { bodyFields } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: draftHandlers } = createFactory<AppEnv, '/flow/draft/:draftId'>();

export function createFlowDraftController(service: FlowDraftService) {
  return {
    saveFlowDraft: createHandlers(async c => {
      const { content, meta = {}, version = 0 } = bodyFields(c.get('parsedBody'));
      const parsedContent = structuredObject.safeParse(content);
      if (!parsedContent.success) return legacyJson(c, Result.fail('参数错误: content 必须是对象'));
      const parsedMeta = structuredObject.safeParse(meta);
      if (!parsedMeta.success) return legacyJson(c, Result.fail('参数错误: meta 必须是对象'));
      const normalizedVersion = parseDraftInteger(version, 0);
      if (normalizedVersion === null) return legacyJson(c, Result.fail('参数错误: version 必须是非负整数'));

      return legacyJson(c, Result.success(await service.upsertFlowDraft(authUserId(c.get('user')), {
        content: parsedContent.data, meta: parsedMeta.data, version: normalizedVersion,
      })));
    }),
    getFlowDraft: createHandlers(async c => legacyJson(c, Result.success(await service.getFlowDraft(authUserId(c.get('user')))))),
    deleteFlowDraft: draftHandlers(async c => {
      const draftId = parseDraftInteger(c.req.param('draftId'), 1);
      if (draftId === null) return legacyJson(c, Result.fail('参数错误: draftId 必须是正整数'));
      return legacyJson(c, Result.success(await service.deleteFlowDraft(authUserId(c.get('user')), draftId)));
    }),
  };
}
