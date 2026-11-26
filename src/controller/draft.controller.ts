import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { DraftService } from '../service/article/article.types.js';
import { parseDraftInteger, structuredObject } from '../http/articleDraftInput.js';
import { bodyFields } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: articleHandlers } = createFactory<AppEnv, '/draft/:articleId'>();
const { createHandlers: draftHandlers } = createFactory<AppEnv, '/draft/:draftId'>();

export function createDraftController(service: DraftService) {
  return {
    saveDraft: createHandlers(async c => {
      const { title = null, content, meta = {}, version = 0, articleId } = bodyFields(c.get('parsedBody'));
      const parsedContent = structuredObject.safeParse(content);
      if (!parsedContent.success) return legacyJson(c, Result.fail('参数错误: content 必须是对象'));
      const parsedMeta = structuredObject.safeParse(meta);
      if (!parsedMeta.success) return legacyJson(c, Result.fail('参数错误: meta 必须是对象'));
      const normalizedVersion = parseDraftInteger(version, 0);
      if (normalizedVersion === null) return legacyJson(c, Result.fail('参数错误: version 必须是非负整数'));
      const normalizedArticleId = articleId == null ? null : parseDraftInteger(articleId, 1);
      if (articleId != null && normalizedArticleId === null) return legacyJson(c, Result.fail('参数错误: articleId 必须是正整数'));

      return legacyJson(c, Result.success(await service.upsertDraft(authUserId(c.get('user')), {
        title,
        content: parsedContent.data,
        meta: parsedMeta.data,
        version: normalizedVersion,
        articleId: normalizedArticleId,
      })));
    }),
    getDraft: createHandlers(async c => legacyJson(c, Result.success(await service.getDraft(authUserId(c.get('user')), null)))),
    getDraftByArticleId: articleHandlers(async c => {
      const articleId = parseDraftInteger(c.req.param('articleId'), 1);
      if (articleId === null) return legacyJson(c, Result.fail('参数错误: articleId 必须是正整数'));
      return legacyJson(c, Result.success(await service.getDraft(authUserId(c.get('user')), articleId)));
    }),
    deleteDraft: draftHandlers(async c => {
      const draftId = parseDraftInteger(c.req.param('draftId'), 1);
      if (draftId === null) return legacyJson(c, Result.fail('参数错误: draftId 必须是正整数'));
      return legacyJson(c, Result.success(await service.deleteDraft(authUserId(c.get('user')), draftId)));
    }),
  };
}
