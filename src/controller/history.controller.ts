import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import { formatHistoryPage, type HistoryService } from '../service/history/history.service.js';
import { bodyFields, queryValue } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: createArticleHandlers } = createFactory<AppEnv, '/history/:articleId' | '/history/:articleId/check'>();

export function createHistoryController(service: HistoryService) {
  return {
    addHistory: createHandlers(async c => {
      const { articleId } = bodyFields(c.get('parsedBody'));
      const result = await service.addHistory(authUserId(c.get('user')), articleId);
      return legacyJson(c, Result.success(result));
    }),

    getUserHistory: createHandlers(async c => {
      const userId = authUserId(c.get('user'));
      const search = new URL(c.req.url).searchParams;
      const offset = queryValue(search, 'offset');
      const limit = queryValue(search, 'limit');
      const rows = await service.getUserHistory(userId, offset, limit);
      const total = await service.getUserHistoryCount(userId);
      return legacyJson(c, Result.success(formatHistoryPage(rows, total, offset, limit)));
    }),

    deleteHistory: createArticleHandlers(async c => {
      const result = await service.deleteHistory(authUserId(c.get('user')), c.req.param('articleId'));
      return legacyJson(c, Result.success(result));
    }),

    clearUserHistory: createHandlers(async c => {
      const result = await service.clearUserHistory(authUserId(c.get('user')));
      return legacyJson(c, Result.success(result));
    }),

    hasViewed: createArticleHandlers(async c => {
      const hasViewed = await service.hasViewed(authUserId(c.get('user')), c.req.param('articleId'));
      return legacyJson(c, Result.success({ hasViewed }));
    }),
  };
}
