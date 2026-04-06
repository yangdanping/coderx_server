const connection = require('@/app/database');
const SqlUtils = require('@/utils/SqlUtils');
const {
  buildAddCommentSql,
  buildAddReplySql,
  buildGetCommentListSql,
  buildGetCommentByIdSql,
  buildGetRepliesSql,
  buildGetReplyPreviewSql,
  buildGetUserCommentListSql,
  buildUserCommentListExecuteParams,
} = require('./comment.sql');

class CommentService {
  /**
   * 获取一级评论列表（分页）
   * @param {string} articleId 文章ID
   * @param {string|null} cursor 游标（上一页最后一条的 createAt_id）
   * @param {number} limit 每页数量
   * @param {'latest'|'oldest'|'hot'} sort 排序方式
   * @param {number} replyPreviewLimit 每条评论预览的回复数量
   */
  /**
   * 重构说明：
   * 1. 将 LIMIT 的硬拼接改为占位符 ?，彻底消除注入风险。
   * 2. 统一使用参数化查询处理所有动态条件。
   */
  getCommentList = async (articleId, cursor, limit, sort = 'latest', replyPreviewLimit = 2) => {
    try {
      const normalizedLimit = Number(limit) || 5;
      const limitForHasMore = String(normalizedLimit + 1);
      let comments = [];

      if (sort === 'hot') {
        const queryParams = [articleId];
        const { condition: cursorCondition, params: cursorParams } = SqlUtils.buildHotCursorCondition(cursor, connection.dialect);
        queryParams.push(...cursorParams, limitForHasMore);

        const statement = buildGetCommentListSql(connection.dialect, {
          sort: 'hot',
          cursorCondition,
        });
        [comments] = await connection.execute(statement, queryParams);
      } else {
        const isOldest = sort === 'oldest';
        const direction = isOldest ? 'ASC' : 'DESC';
        const queryParams = [articleId];
        const { condition: cursorCondition, params: cursorParams } = SqlUtils.buildTimeCursorCondition(cursor, direction, connection.dialect);
        queryParams.push(...cursorParams, limitForHasMore);

        const statement = buildGetCommentListSql(connection.dialect, {
          sort,
          cursorCondition,
          direction,
        });
        [comments] = await connection.execute(statement, queryParams);
      }

      // 判断是否有更多
      const hasMore = comments.length > normalizedLimit;
      const items = hasMore ? comments.slice(0, normalizedLimit) : comments;

      // 处理每条评论的内容和状态
      items.forEach((comment) => {
        if (comment.status) {
          comment.content = '评论已被封禁';
        }
      });

      // 为每条一级评论获取前 N 条回复预览
      for (const comment of items) {
        comment.replies = await this.getReplyPreview(comment.id, String(replyPreviewLimit));
      }

      // 计算下一页游标
      let nextCursor = null;
      if (hasMore && items.length > 0) {
        nextCursor = sort === 'hot' ? SqlUtils.buildHotNextCursor(items[items.length - 1], connection.dialect) : SqlUtils.buildNextCursor(items[items.length - 1], connection.dialect);
      }

      return {
        items,
        nextCursor,
        hasMore,
      };
    } catch (error) {
      console.error('getCommentList error:', error);
      throw error;
    }
  };

  /**
   * 获取用户的评论列表（标准分页）
   * @param {string} userId 用户ID
   * @param {string} offset 偏移量
   * @param {string} limit 每页数量
   */
  getUserCommentList = async (userId, offset, limit) => {
    try {
      const statement = buildGetUserCommentListSql(connection.dialect);
      const executeParams = buildUserCommentListExecuteParams(connection.dialect, userId, String(offset), String(limit));
      const [comments] = await connection.execute(statement, executeParams);

      // 处理数据格式
      const items = comments.map((item) => {
        // 组装 articleUrl (假设路由结构)
        item.articleUrl = `/article/${item.articleId}`;

        if (item.status) {
          item.content = '评论已被封禁';
        }
        return item;
      });

      return items; // 前端似乎直接期望一个数组，或者 { items, total }?
      // 查看前端 stores/comment.store.ts getCommentAction:
      // this.userComments = res.data as any;
      // UserComment.vue 使用 profile.commentCount 作为 total，所以这里只要返回列表即可?
      // 但是通常 API 返回 { list, total } 比较好。
      // 前端请求是: return myRequest.get<IResData<IComment[]>>
      // 所以 res.data 应该是 IComment[] 数组。
      // 这里的 items 就是数组。
    } catch (error) {
      console.error('getUserCommentList error:', error);
      throw error;
    }
  };

  /**
   * 重构说明：
   * 1. 将 LIMIT 的硬拼接改为占位符 ?。
   */
  getReplyPreview = async (commentId, limit) => {
    try {
      const statement = buildGetReplyPreviewSql(connection.dialect);

      const [replies] = await connection.execute(statement, [commentId, limit]);

      replies.forEach((reply) => {
        if (reply.status) {
          reply.content = '评论已被封禁';
        }
      });

      return replies;
    } catch (error) {
      console.error('getReplyPreview error:', error);
      return [];
    }
  };

  /**
   * 重构说明：
   * 1. 将 LIMIT 的硬拼接改为占位符 ?。
   */
  getReplies = async (commentId, cursor, limit) => {
    try {
      const normalizedLimit = Number(limit) || 10;
      const queryParams = [commentId];
      const { condition: cursorCondition, params: cursorParams } = SqlUtils.buildCursorCondition(cursor, 'ASC', connection.dialect);
      queryParams.push(...cursorParams);

      const limitForHasMore = String(normalizedLimit + 1);
      queryParams.push(limitForHasMore);

      const statement = buildGetRepliesSql(connection.dialect, {
        cursorCondition,
      });

      const [replies] = await connection.execute(statement, queryParams);

      const hasMore = replies.length > normalizedLimit;
      const items = hasMore ? replies.slice(0, normalizedLimit) : replies;

      items.forEach((reply) => {
        if (reply.status) {
          reply.content = '评论已被封禁';
        }
      });

      // 获取该评论下的总回复数
      const [[{ replyCount }]] = await connection.execute('SELECT COUNT(*) AS "replyCount" FROM comment WHERE comment_id = ?', [commentId]);

      let nextCursor = null;
      if (hasMore && items.length > 0) {
        nextCursor = SqlUtils.buildNextCursor(items[items.length - 1], connection.dialect);
      }

      return {
        items,
        nextCursor,
        hasMore,
        replyCount,
      };
    } catch (error) {
      console.error('getReplies error:', error);
      throw error;
    }
  };

  /**
   * 获取文章的评论总数（包括所有层级）
   */
  getTotalCount = async (articleId) => {
    try {
      const statement = `SELECT COUNT(*) AS "totalCount" FROM comment WHERE article_id = ?`;
      const [[result]] = await connection.execute(statement, [articleId]);
      return result.totalCount;
    } catch (error) {
      console.error('getTotalCount error:', error);
      return 0;
    }
  };

  /**
   * 新增一级评论
   */
  addComment = async (userId, articleId, content) => {
    try {
      const statement = buildAddCommentSql(connection.dialect);
      const [result] = await connection.execute(statement, [userId, articleId, content]);

      if (result.insertId) {
        // 返回新创建的评论完整信息
        return await this.getCommentById(result.insertId);
      }
      return null;
    } catch (error) {
      console.error('addComment error:', error);
      throw error;
    }
  };

  /**
   * 回复评论
   * @param {number} userId 用户ID
   * @param {number} articleId 文章ID
   * @param {number} commentId 被回复的一级评论ID（cid）
   * @param {number|null} replyId 被回复的回复ID（rid，如果是回复的回复）
   * @param {string} content 内容
   */
  addReply = async (userId, articleId, commentId, replyId, content) => {
    try {
      let queryParams;

      if (replyId) {
        // 回复的回复
        queryParams = [userId, articleId, commentId, replyId, content];
      } else {
        // 回复一级评论
        queryParams = [userId, articleId, commentId, content];
      }

      const statement = buildAddReplySql(connection.dialect, !!replyId);
      const [result] = await connection.execute(statement, queryParams);

      if (result.insertId) {
        return await this.getCommentById(result.insertId);
      }
      return null;
    } catch (error) {
      console.error('addReply error:', error);
      throw error;
    }
  };

  /**
   * 获取单条评论详情
   */
  getCommentById = async (commentId) => {
    try {
      const statement = buildGetCommentByIdSql(connection.dialect);

      const [[comment]] = await connection.execute(statement, [commentId]);

      if (comment && comment.status) {
        comment.content = '评论已被封禁';
      }

      return comment || null;
    } catch (error) {
      console.error('getCommentById error:', error);
      return null;
    }
  };

  /**
   * 更新评论内容
   */
  updateComment = async (commentId, content) => {
    try {
      const statement = `UPDATE comment SET content = ? WHERE id = ?`;
      const [result] = await connection.execute(statement, [content, commentId]);

      if (result.affectedRows > 0) {
        return await this.getCommentById(commentId);
      }
      return null;
    } catch (error) {
      console.error('updateComment error:', error);
      throw error;
    }
  };

  /**
   * 删除评论（级联删除所有回复）
   */
  deleteComment = async (commentId) => {
    try {
      // 先获取评论信息（用于返回）
      const comment = await this.getCommentById(commentId);

      // 删除该评论下的所有回复
      await connection.execute('DELETE FROM comment WHERE comment_id = ?', [commentId]);
      // 删除该评论下回复的回复（如果有 reply_id 指向被删除的回复）
      await connection.execute('DELETE FROM comment WHERE reply_id = ?', [commentId]);
      // 删除该评论本身
      const [result] = await connection.execute('DELETE FROM comment WHERE id = ?', [commentId]);

      return result.affectedRows > 0 ? comment : null;
    } catch (error) {
      console.error('deleteComment error:', error);
      throw error;
    }
  };
}

module.exports = new CommentService();
