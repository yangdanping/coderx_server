import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import * as errors from '../constants/errorTypes.js';
import {
  matchesCollectName,
  parseCollectArticleSelection,
  type CollectService,
} from '../service/collect/collect.service.js';
import { LegacyEmittedError } from '../http/legacyError.js';
import { bodyFields, pagination, queryValue } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: createCollectHandlers } = createFactory<AppEnv, '/collect/:collectId' | '/collect/:collectId/articles'>();
const { createHandlers: createCollectListHandlers } = createFactory<AppEnv, '/collect/:userId'>();

export function createCollectController(service: Pick<CollectService,
  'addCollect' | 'getCollectByName' | 'getCollectList' | 'toggleCollect' |
  'removeCollectArticle' | 'getCollectArticle' | 'updateCollect' | 'removeCollect'>) {
  return {
    addCollect: createHandlers(async c => {
      const userId = authUserId(c.get('user'));
      const { name } = bodyFields(c.get('parsedBody'));
      const collection = await service.getCollectByName(userId, name);
      if (matchesCollectName(collection, name)) throw new LegacyEmittedError(errors.NAME_EXISTS);
      return legacyJson(c, Result.success(await service.addCollect(userId, name)));
    }),

    getList: createCollectListHandlers(async c => {
      const { offset, limit } = pagination(new URL(c.req.url).searchParams);
      const result = await service.getCollectList(c.req.param('userId'), offset, limit);
      return legacyJson(c, Result.success(result));
    }),

    collectArticle: createCollectHandlers(async c => {
      const { articleId } = bodyFields(c.get('parsedBody'));
      const result = await service.toggleCollect(articleId, Math.round(Number(c.req.param('collectId'))));
      return legacyJson(c, Result.success(result));
    }),

    removeCollectArticle: createCollectHandlers(async c => {
      const idList = queryValue(new URL(c.req.url).searchParams, 'idList');
      const parsed = parseCollectArticleSelection(c.req.param('collectId'), idList);
      if (!parsed.ok) return legacyJson(c, Result.fail(parsed.message));
      await service.removeCollectArticle(parsed.collectId, parsed.ids);
      const result = await service.getCollectArticle(parsed.collectId);
      return legacyJson(c, Result.success(result));
    }),

    updateCollect: createCollectHandlers(async c => {
      const { name } = bodyFields(c.get('parsedBody'));
      const result = await service.updateCollect(c.req.param('collectId'), name);
      return legacyJson(c, Result.success(result));
    }),

    removeCollect: createCollectHandlers(async c => {
      const result = await service.removeCollect(c.req.param('collectId'));
      return legacyJson(c, Result.success(result));
    }),
  };
}
