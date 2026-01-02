const commentService = require('@/service/comment.service.js');
const userService = require('@/service/user.service.js');
const Result = require('@/app/Result');
const Utils = require('@/utils');

class CommentController {
  /**
   * 获取一级评论列表（分页）
   * GET /comment?articleId=xxx&cursor=xxx&limit=5
   */
  getCommentList = async (ctx) => {
    const { articleId, cursor, userId } = ctx.query;
    const { offset, limit } = Utils.getPaginationParams(ctx);

    // 情况1：获取用户的评论列表（标准分页）
    if (userId) {
      try {
        const result = await commentService.getUserCommentList(userId, offset, limit);
        result.forEach((comment) => {
          if (!comment.status) {
            // 清理HTML标签并截取内容长度
            comment.content = Utils.removeHTMLTag(comment.content);
            if (comment.content.length > 50) {
              comment.content = comment.content.slice(0, 50);
            }
          } else {
            // 被封禁的评论显示提示信息
            comment.content = '评论已被封禁';
          }
        });
        ctx.body = result ? Result.success(result) : Result.fail('获取用户评论列表失败!');
        return;
      } catch (error) {
        console.error('getUserCommentList error:', error);
        ctx.body = Result.fail('获取用户评论列表失败');
        return;
      }
    }

    // 情况2：获取文章的评论列表（游标分页）
    if (!articleId) {
      ctx.body = Result.fail('articleId is required');
      return;
    }

    try {
      const result = await commentService.getCommentList(articleId, cursor || null, Number(limit) || 5);

      // 获取评论总数
      const totalCount = await commentService.getTotalCount(articleId);

      ctx.body = Result.success({
        ...result,
        totalCount,
      });
    } catch (error) {
      console.error('getCommentList error:', error);
      ctx.body = Result.fail('获取评论列表失败');
    }
  };

  /**
   * 获取某条评论的回复列表（分页）
   * GET /comment/:commentId/replies?cursor=xxx&limit=10
   */
  getReplies = async (ctx) => {
    const { commentId } = ctx.params;
    const { cursor } = ctx.query;
    const { limit } = Utils.getPaginationParams(ctx);

    try {
      const result = await commentService.getReplies(commentId, cursor || null, Number(limit) || 10);

      ctx.body = Result.success(result);
    } catch (error) {
      console.error('getReplies error:', error);
      ctx.body = Result.fail('获取回复列表失败');
    }
  };

  /**
   * 获取评论总数
   * GET /comment/count?articleId=xxx
   */
  getTotalCount = async (ctx) => {
    const { articleId } = ctx.query;

    if (!articleId) {
      ctx.body = Result.fail('articleId is required');
      return;
    }

    try {
      const totalCount = await commentService.getTotalCount(articleId);
      ctx.body = Result.success({ totalCount });
    } catch (error) {
      console.error('getTotalCount error:', error);
      ctx.body = Result.fail('获取评论总数失败');
    }
  };

  /**
   * 新增一级评论
   * POST /comment
   */
  addComment = async (ctx) => {
    const userId = ctx.user.id;
    const { articleId, content } = ctx.request.body;

    if (!articleId || !content) {
      ctx.body = Result.fail('articleId and content are required');
      return;
    }

    try {
      const comment = await commentService.addComment(userId, articleId, content);

      if (comment) {
        // 返回新评论和更新后的总数
        const totalCount = await commentService.getTotalCount(articleId);
        ctx.body = Result.success({
          comment,
          totalCount,
        });
      } else {
        ctx.body = Result.fail('发表评论失败');
      }
    } catch (error) {
      console.error('addComment error:', error);
      ctx.body = Result.fail('发表评论失败');
    }
  };

  /**
   * 回复评论
   * POST /comment/:commentId/reply
   */
  addReply = async (ctx) => {
    const userId = ctx.user.id;
    const { commentId } = ctx.params;
    const { articleId, content, replyId } = ctx.request.body;

    if (!articleId || !content) {
      ctx.body = Result.fail('articleId and content are required');
      return;
    }

    try {
      const reply = await commentService.addReply(userId, articleId, commentId, replyId || null, content);

      if (reply) {
        const totalCount = await commentService.getTotalCount(articleId);
        ctx.body = Result.success({
          reply,
          totalCount,
        });
      } else {
        ctx.body = Result.fail('回复评论失败');
      }
    } catch (error) {
      console.error('addReply error:', error);
      ctx.body = Result.fail('回复评论失败');
    }
  };

  /**
   * 点赞评论
   * POST /comment/:commentId/like
   */
  likeComment = async (ctx) => {
    const userId = ctx.user.id;
    const { commentId } = ctx.params;

    try {
      // 切换点赞状态
      const result = await userService.toggleLike('comment', commentId, userId);

      // 获取更新后的点赞总数
      const comment = await commentService.getCommentById(commentId);
      const likes = comment ? comment.likes : 0;

      // 返回正确格式
      ctx.body = Result.success({
        liked: result.isLiked,
        likes: likes,
      });
    } catch (error) {
      console.error('likeComment error:', error);
      ctx.body = Result.fail('操作失败');
    }
  };

  /**
   * 获取单条评论
   * GET /comment/:commentId
   */
  getCommentById = async (ctx) => {
    const { commentId } = ctx.params;

    try {
      const comment = await commentService.getCommentById(commentId);

      if (comment) {
        ctx.body = Result.success(comment);
      } else {
        ctx.body = Result.fail('评论不存在');
      }
    } catch (error) {
      console.error('getCommentById error:', error);
      ctx.body = Result.fail('获取评论失败');
    }
  };

  /**
   * 更新评论
   * PUT /comment/:commentId
   */
  updateComment = async (ctx) => {
    const { commentId } = ctx.params;
    const { content } = ctx.request.body;

    if (!content) {
      ctx.body = Result.fail('content is required');
      return;
    }

    try {
      const comment = await commentService.updateComment(commentId, content);

      if (comment) {
        ctx.body = Result.success(comment);
      } else {
        ctx.body = Result.fail('修改评论失败');
      }
    } catch (error) {
      console.error('updateComment error:', error);
      ctx.body = Result.fail('修改评论失败');
    }
  };

  /**
   * 删除评论
   * DELETE /comment/:commentId
   */
  deleteComment = async (ctx) => {
    const { commentId } = ctx.params;

    try {
      // 先获取评论信息，用于返回 articleId
      const comment = await commentService.getCommentById(commentId);

      if (!comment) {
        ctx.body = Result.fail('评论不存在');
        return;
      }

      const result = await commentService.deleteComment(commentId);

      if (result) {
        // 返回更新后的总数
        const totalCount = await commentService.getTotalCount(comment.articleId);
        ctx.body = Result.success({
          deletedComment: result,
          totalCount,
        });
      } else {
        ctx.body = Result.fail('删除评论失败');
      }
    } catch (error) {
      console.error('deleteComment error:', error);
      ctx.body = Result.fail('删除评论失败');
    }
  };
}

module.exports = new CommentController();
