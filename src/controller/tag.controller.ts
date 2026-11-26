import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { TagService } from '../service/tag/tag.service.js';
import { bodyFields, queryValue } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();

export function createTagController(service: Pick<TagService, 'addTag' | 'getTagList' | 'getUserTagOrder' | 'replaceUserTagOrder'>) {
  return {
    addTag: createHandlers(async c => {
      const { name } = bodyFields(c.get('parsedBody'));
      return legacyJson(c, Result.success(await service.addTag(name)));
    }),

    getList: createHandlers(async c => {
      const query = new URL(c.req.url).searchParams;
      const offset = queryValue(query, 'offset') ?? '0';
      const limit = queryValue(query, 'limit') ?? '99';
      return legacyJson(c, Result.success(await service.getTagList(offset, limit)));
    }),

    getUserOrder: createHandlers(async c => {
      const userId = authUserId(c.get('user'));
      return legacyJson(c, Result.success(await service.getUserTagOrder(userId)));
    }),

    replaceUserOrder: createHandlers(async c => {
      const userId = authUserId(c.get('user'));
      const { tagIds } = bodyFields(c.get('parsedBody'));
      return legacyJson(c, Result.success(await service.replaceUserTagOrder(userId, tagIds)));
    }),
  };
}
