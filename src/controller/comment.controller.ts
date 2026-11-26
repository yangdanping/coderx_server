import { createFactory } from 'hono/factory';
import Result from '../app/Result.js';
import type { createCommentService } from '../service/comment.factory.js';
import type { createCommentLikeService } from '../service/commentLike.factory.js';
import { removeHTMLTag } from '../utils/text.js';
import { bodyFields, pagination, queryValue } from '../http/legacyInput.js';
import { legacyJson } from '../http/legacyResponse.js';
import { authUserId, type AppEnv } from '../http/types.js';

const { createHandlers } = createFactory<AppEnv>();
const { createHandlers: createCommentHandlers } = createFactory<AppEnv, '/comment/:commentId'>();
const { createHandlers: createRepliesHandlers } = createFactory<AppEnv, '/comment/:commentId/replies'>();
const { createHandlers: createReplyHandlers } = createFactory<AppEnv, '/comment/:commentId/reply'>();
const { createHandlers: createLikeHandlers } = createFactory<AppEnv, '/comment/:commentId/like'>();

export function createCommentController(
  service: ReturnType<typeof createCommentService>,
  likeService: ReturnType<typeof createCommentLikeService>,
) {
  return {
    getCommentList: createHandlers(async c => {
      const search = new URL(c.req.url).searchParams;
      const userId = queryValue(search, 'userId');
      const { offset, limit } = pagination(search);
      if (userId) {
        try {
          const result = await service.getUserCommentList(userId, offset, limit);
          if (!result) return legacyJson(c, Result.fail('获取用户评论列表失败!'));
          for (const comment of result.items) {
            comment.content = comment.status ? '评论已被封禁' : removeHTMLTag(comment.content).slice(0, 50);
          }
          return legacyJson(c, Result.success(result));
        } catch (error) {
          console.error('getUserCommentList error:', error);
          return legacyJson(c, Result.fail('获取用户评论列表失败'));
        }
      }

      const articleId = queryValue(search, 'articleId');
      if (!articleId) return legacyJson(c, Result.fail('articleId is required'));
      const cursor = queryValue(search, 'cursor') || null;
      const sort = queryValue(search, 'sort');
      try {
        const result = await service.getCommentList(articleId, cursor, Number(limit) || 5, sort === 'hot' || sort === 'oldest' ? sort : 'latest');
        const totalCount = await service.getTotalCount(articleId);
        return legacyJson(c, Result.success({ ...result, totalCount }));
      } catch (error) {
        console.error('getCommentList error:', error);
        return legacyJson(c, Result.fail('获取评论列表失败'));
      }
    }),

    getReplies: createRepliesHandlers(async c => {
      const search = new URL(c.req.url).searchParams;
      const cursor = queryValue(search, 'cursor') || null;
      const limit = Number(pagination(search).limit);
      try {
        const result = await service.getReplies(c.req.param('commentId'), cursor, limit > 0 ? limit : 10);
        return legacyJson(c, Result.success(result));
      } catch (error) {
        console.error('getReplies error:', error);
        return legacyJson(c, Result.fail('获取回复列表失败'));
      }
    }),

    getTotalCount: createHandlers(async c => {
      const articleId = queryValue(new URL(c.req.url).searchParams, 'articleId');
      if (!articleId) return legacyJson(c, Result.fail('articleId is required'));
      try {
        const totalCount = await service.getTotalCount(articleId);
        return legacyJson(c, Result.success({ totalCount }));
      } catch (error) {
        console.error('getTotalCount error:', error);
        return legacyJson(c, Result.fail('获取评论总数失败'));
      }
    }),

    addComment: createHandlers(async c => {
      const { articleId, content } = bodyFields(c.get('parsedBody'));
      if (!articleId || !content) return legacyJson(c, Result.fail('articleId and content are required'));
      try {
        const comment = await service.addComment(authUserId(c.get('user')), articleId, content);
        if (!comment) return legacyJson(c, Result.fail('发表评论失败'));
        const totalCount = await service.getTotalCount(articleId);
        return legacyJson(c, Result.success({ comment, totalCount }));
      } catch (error) {
        console.error('addComment error:', error);
        return legacyJson(c, Result.fail('发表评论失败'));
      }
    }),

    addReply: createReplyHandlers(async c => {
      const { articleId, content, replyId } = bodyFields(c.get('parsedBody'));
      if (!articleId || !content) return legacyJson(c, Result.fail('articleId and content are required'));
      try {
        const reply = await service.addReply(authUserId(c.get('user')), articleId, c.req.param('commentId'), replyId || null, content);
        if (!reply) return legacyJson(c, Result.fail('回复评论失败'));
        const totalCount = await service.getTotalCount(articleId);
        return legacyJson(c, Result.success({ reply, totalCount }));
      } catch (error) {
        console.error('addReply error:', error);
        return legacyJson(c, Result.fail('回复评论失败'));
      }
    }),

    likeComment: createLikeHandlers(async c => {
      const commentId = c.req.param('commentId');
      try {
        const { isLiked } = await likeService.toggleCommentLike(commentId, authUserId(c.get('user')));
        const comment = await service.getCommentById(commentId);
        return legacyJson(c, Result.success({ liked: isLiked, likes: comment ? comment.likes : 0 }));
      } catch (error) {
        console.error('likeComment error:', error);
        return legacyJson(c, Result.fail('操作失败'));
      }
    }),

    getCommentById: createCommentHandlers(async c => {
      try {
        const comment = await service.getCommentById(c.req.param('commentId'));
        return legacyJson(c, comment ? Result.success(comment) : Result.fail('评论不存在'));
      } catch (error) {
        console.error('getCommentById error:', error);
        return legacyJson(c, Result.fail('获取评论失败'));
      }
    }),

    updateComment: createCommentHandlers(async c => {
      const { content } = bodyFields(c.get('parsedBody'));
      if (!content) return legacyJson(c, Result.fail('content is required'));
      try {
        const comment = await service.updateComment(c.req.param('commentId'), content);
        return legacyJson(c, comment ? Result.success(comment) : Result.fail('修改评论失败'));
      } catch (error) {
        console.error('updateComment error:', error);
        return legacyJson(c, Result.fail('修改评论失败'));
      }
    }),

    deleteComment: createCommentHandlers(async c => {
      const commentId = c.req.param('commentId');
      try {
        const comment = await service.getCommentById(commentId);
        if (!comment) return legacyJson(c, Result.fail('评论不存在'));
        const deletedComment = await service.deleteComment(commentId);
        if (!deletedComment) return legacyJson(c, Result.fail('删除评论失败'));
        const totalCount = await service.getTotalCount(comment.articleId);
        return legacyJson(c, Result.success({ deletedComment, totalCount }));
      } catch (error) {
        console.error('deleteComment error:', error);
        return legacyJson(c, Result.fail('删除评论失败'));
      }
    }),
  };
}
