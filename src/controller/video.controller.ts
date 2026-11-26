import { createFactory } from 'hono/factory';
import type { createVideoOperations } from '../service/videoOperations.factory.js';
import { bodyFields } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: articleHandlers } = createFactory<AppEnv, '/video/:articleId'>();
const { createHandlers: detailHandlers } = createFactory<AppEnv, '/video/:videoId'>();

type VideoOperations = Pick<ReturnType<typeof createVideoOperations>, 'saveUpload' | 'associate' | 'deleteByIds' | 'getDetail'>;

export function createVideoController(operations: VideoOperations) {
  return {
    saveVideoInfo: createHandlers(async c => legacyJson(c, await operations.saveUpload(
      authUserId(c.get('user')), c.get('diskUploads')?.[0],
    ))),
    updateVideoArticle: articleHandlers(async c => legacyJson(c, await operations.associate(
      c.req.param('articleId'), bodyFields(c.get('parsedBody')).videoIds, authUserId(c.get('user')),
    ))),
    deleteVideo: createHandlers(async c => legacyJson(c, await operations.deleteByIds(
      bodyFields(c.get('parsedBody')).videoIds, authUserId(c.get('user')),
    ))),
    getVideoInfo: detailHandlers(async c => legacyJson(c, await operations.getDetail(c.req.param('videoId')))),
  };
}
