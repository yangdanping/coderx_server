import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { AvatarMutationService } from '../service/avatar/avatar.service.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: deleteHandlers } = createFactory<AppEnv, '/avatar/:userId'>();

function avatarOwnerId(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\+?[0-9]+$/.test(value.trim()))) return null;
  const userId = Number(value);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

export function createAvatarController(service: AvatarMutationService) {
  return {
    saveAvatar: createHandlers(async c => {
      const file = c.get('diskUploads')?.[0];
      if (!file) throw new TypeError("Cannot destructure property 'filename' of 'ctx.file' as it is undefined.");
      return legacyJson(c, Result.success(await service.saveAvatar(authUserId(c.get('user')), file)));
    }),
    deleteAvatar: deleteHandlers(async c => {
      const userId = c.req.param('userId');
      const ownerId = avatarOwnerId(authUserId(c.get('user')));
      if (ownerId === null || ownerId !== avatarOwnerId(userId)) {
        return legacyJson(c, Result.fail('不具备操作的权限', 403), 403);
      }
      return legacyJson(c, Result.success(await service.deleteAvatar(userId)));
    }),
  };
}
