import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import * as errors from '../constants/errorTypes.js';
import type { AvatarMetadata } from '../service/avatar/avatar.service.js';
import { legacyUserQueryResult, type createUserService } from '../service/user.factory.js';
import type { createSignUserToken } from '../service/user/userToken.service.js';
import { comparePwd, hashPwd } from '../utils/password.js';
import { removeHTMLTag } from '../utils/text.js';
import { validateOptionalNickname } from '../utils/nickname.js';
import { LegacyEmittedError } from '../http/legacyError.js';
import { bodyFields, pagination, queryValue } from '../http/legacyInput.js';
import { localFileResponse, openLocalMedia } from '../http/fileResponseBody.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

type UserService = Pick<ReturnType<typeof createUserService>,
  'getUserByName' | 'addUser' | 'getProfileById' | 'updateProfileById' | 'getLikedById' |
  'toggleFollow' | 'getFollowInfo' | 'getArticleByCollectId' | 'getCommentById' | 'userReport' | 'getHotUsers'>;

interface UserDependencies {
  service: UserService;
  getAvatarById: (userId: string) => Promise<AvatarMetadata | undefined>;
  avatarRoot: string;
  signToken: ReturnType<typeof createSignUserToken>;
}

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: createUserHandlers } = createFactory<AppEnv, `/user/:userId/${string}`>();

export function createUserController({ service, getAvatarById, avatarRoot, signToken }: UserDependencies) {
  return {
    checkAuth: createHandlers(c => legacyJson(c, Result.success(undefined))),

    register: createHandlers(async c => {
      const { name, password, nickname } = bodyFields(c.get('parsedBody'));
      if (!name || !password) throw new LegacyEmittedError(errors.NAME_OR_PWD_IS_INCORRECT);

      const normalizedNickname = validateOptionalNickname(nickname);
      if (await service.getUserByName(name)) throw new LegacyEmittedError(errors.USERNAME_EXISTS);

      const result = await service.addUser({ name, password: hashPwd(password), nickname: normalizedNickname });
      return legacyJson(c, Result.success(result));
    }),

    login: createHandlers(async c => {
      const { name, password } = bodyFields(c.get('parsedBody'));
      if (!name || !password) throw new LegacyEmittedError(errors.NAME_OR_PWD_IS_INCORRECT);

      const user = await service.getUserByName(name);
      if (!user) throw new LegacyEmittedError(errors.USER_DOES_NOT_EXISTS);
      if (!comparePwd(password, user.password)) throw new LegacyEmittedError(errors.PWD_IS_INCORRECT);

      const token = signToken(user);
      return legacyJson(c, token ? Result.success({ id: user.id, name: user.name, token }) : Result.fail('生成token失败'));
    }),

    getProfile: createUserHandlers(async c => legacyJson(c, Result.success(await service.getProfileById(c.req.param('userId'))))),

    updateProfile: createHandlers(async c => {
      const result = await service.updateProfileById(authUserId(c.get('user')), c.get('parsedBody'));
      return legacyJson(c, Result.success(result));
    }),

    getLiked: createUserHandlers(async c => {
      const userId = c.req.param('userId');
      const result = !userId || !Number.isFinite(Number(userId))
        ? { articleLiked: [], commentLiked: [] }
        : await legacyUserQueryResult(service.getLikedById(userId));
      return legacyJson(c, Result.success(result));
    }),

    getAvatar: createUserHandlers(async c => {
      const avatar = await getAvatarById(c.req.param('userId'));
      if (!avatar) return c.notFound();
      const asset = await openLocalMedia(avatarRoot, avatar.filename);
      if (!asset) return c.notFound();
      return localFileResponse(c, asset, avatar.mimetype);
    }),

    toggleFollow: createUserHandlers(async c => {
      const followerId = authUserId(c.get('user'));
      const userId = c.req.param('userId');
      // The legacy controller's unbound BusinessError made numeric self-follow a system error.
      if (followerId === parseInt(userId)) throw new ReferenceError('BusinessError is not defined');
      return legacyJson(c, Result.success(await service.toggleFollow(userId, followerId)));
    }),

    getFollow: createUserHandlers(async c => {
      const result = await legacyUserQueryResult(service.getFollowInfo(c.req.param('userId')));
      return legacyJson(c, Result.success(result));
    }),

    getComment: createUserHandlers(async c => {
      const { offset, limit } = pagination(new URL(c.req.url).searchParams);
      const comments = await service.getCommentById(c.req.param('userId'), offset, limit);
      for (const comment of comments) comment.content = removeHTMLTag(comment.content);
      return legacyJson(c, Result.success(comments));
    }),

    getCollect: createUserHandlers(async c => {
      const search = new URL(c.req.url).searchParams;
      const { offset, limit } = pagination(search);
      const result = await legacyUserQueryResult(
        service.getArticleByCollectId(c.req.param('userId'), queryValue(search, 'collectId'), offset, limit),
      );
      return legacyJson(c, Result.success(result));
    }),

    report: createUserHandlers(async c => {
      const { reportOptions, articleId, commentId } = bodyFields(c.get('parsedBody'));
      if (!Array.isArray(reportOptions)) {
        throw new TypeError(reportOptions == null
          ? `Cannot read properties of ${reportOptions} (reading 'join')`
          : 'reportOptions.join is not a function');
      }
      const userId = parseInt(c.req.param('userId'));
      const options = reportOptions.join(' ');
      const report = commentId ? service.userReport(userId, options, null, commentId) : service.userReport(userId, options, articleId);
      const result = await legacyUserQueryResult(report);
      return legacyJson(c, Result.success(result));
    }),

    getHot: createHandlers(async c => {
      const result = await legacyUserQueryResult(service.getHotUsers());
      return legacyJson(c, Result.success(result));
    }),
  };
}
