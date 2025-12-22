const { connection } = require('../app');
const { baseURL, redirectURL } = require('../constants/urls');

class CommentService {
  /**
   * 获取一级评论列表（分页）
   * @param {string} articleId 文章ID
   * @param {string|null} cursor 游标（上一页最后一条的 createAt_id）
   * @param {number} limit 每页数量
   * @param {number} replyPreviewLimit 每条评论预览的回复数量
   */
  /**
   * 重构说明：
   * 1. 将 LIMIT 的硬拼接改为占位符 ?，彻底消除注入风险。
   * 2. 统一使用参数化查询处理所有动态条件。
   */
  getCommentList = async (articleId, cursor, limit, replyPreviewLimit = 2) => {
    try {
      // 解析游标
      let cursorCondition = '';
      const params = [articleId];

      if (cursor) {
        // 游标格式: "timestamp_id" 例如 "2024-01-01T00:00:00.000Z_123"
        const [cursorTime, cursorId] = cursor.split('_');
        cursorCondition = `AND (c.create_at < ? OR (c.create_at = ? AND c.id < ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      }

      // 确保 limit 是整数
      const limitNum = parseInt(limit, 10) + 1; // 多查一条用于判断 hasMore
      params.push(limitNum);

      // 查询一级评论（comment_id IS NULL）
      const statement = `
        SELECT 
          c.id,
          c.content,
          c.status,
          c.create_at AS createAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) AS author,
          (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) AS likes,
          (SELECT COUNT(*) FROM comment r WHERE r.comment_id = c.id) AS replyCount
        FROM comment c
        LEFT JOIN user u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE c.article_id = ? 
          AND c.comment_id IS NULL
          ${cursorCondition}
        ORDER BY c.create_at DESC, c.id DESC
        LIMIT ?
      `;

      const [comments] = await connection.execute(statement, params);

      // 判断是否有更多
      const hasMore = comments.length > limit;
      const items = hasMore ? comments.slice(0, limit) : comments;

      // 处理每条评论的内容和状态
      items.forEach((comment) => {
        if (comment.status) {
          comment.content = '评论已被封禁';
        }
      });

      // 为每条一级评论获取前 N 条回复预览
      for (const comment of items) {
        comment.replies = await this.getReplyPreview(comment.id, replyPreviewLimit);
      }

      // 计算下一页游标
      let nextCursor = null;
      if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1];
        // 把 Date 对象转成 ISO 字符串，避免 toString() 导致格式问题
        const createAtStr = lastItem.createAt instanceof Date ? lastItem.createAt.toISOString() : lastItem.createAt;
        nextCursor = `${createAtStr}_${lastItem.id}`;
      }

      return {
        items,
        nextCursor,
        hasMore
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
      const statement = `
        SELECT 
          c.id,
          c.content,
          c.status,
          c.create_at AS createAt,
          c.update_at AS updateAt,
          c.article_id AS articleId,
          a.title AS articleTitle,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) AS author,
          JSON_OBJECT('id', a.id, 'title', a.title) AS article,
          (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) AS likes
        FROM comment c
        LEFT JOIN user u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        LEFT JOIN article a ON a.id = c.article_id
        WHERE c.user_id = ?
        ORDER BY c.create_at DESC
        LIMIT ?, ?
      `;

      const [comments] = await connection.execute(statement, [userId, String(offset), String(limit)]);

      // 获取总数
      const countStatement = `SELECT COUNT(*) AS total FROM comment WHERE user_id = ?`;
      const [[{ total }]] = await connection.execute(countStatement, [userId]);

      // 处理数据格式
      const items = comments.map((item) => {
        // 构建 articleUrl (假设路由结构)
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
      const limitNum = parseInt(limit, 10);
      const statement = `
        SELECT 
          c.id,
          c.content,
          c.status,
          c.comment_id AS cid,
          c.reply_id AS rid,
          c.create_at AS createAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) AS author,
          (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) AS likes,
          (SELECT JSON_OBJECT('id', ru.id, 'name', ru.name, 'content', rc.content) 
           FROM comment rc 
           LEFT JOIN user ru ON ru.id = rc.user_id 
           WHERE rc.id = c.reply_id) AS replyTo
        FROM comment c
        LEFT JOIN user u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE c.comment_id = ?
        ORDER BY c.create_at ASC
        LIMIT ?
      `;

      const [replies] = await connection.execute(statement, [commentId, limitNum]);

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
      let cursorCondition = '';
      const params = [commentId];

      if (cursor) {
        const [cursorTime, cursorId] = cursor.split('_');
        cursorCondition = `AND (c.create_at > ? OR (c.create_at = ? AND c.id > ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      }

      const limitNum = parseInt(limit, 10) + 1; // 多查一条用于判断 hasMore
      params.push(limitNum);

      const statement = `
        SELECT 
          c.id,
          c.content,
          c.status,
          c.comment_id AS cid,
          c.reply_id AS rid,
          c.create_at AS createAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) AS author,
          (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) AS likes,
          (SELECT JSON_OBJECT('id', ru.id, 'name', ru.name, 'content', rc.content) 
           FROM comment rc 
           LEFT JOIN user ru ON ru.id = rc.user_id 
           WHERE rc.id = c.reply_id) AS replyTo
        FROM comment c
        LEFT JOIN user u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE c.comment_id = ?
          ${cursorCondition}
        ORDER BY c.create_at ASC, c.id ASC
        LIMIT ?
      `;

      const [replies] = await connection.execute(statement, params);

      const hasMore = replies.length > limit;
      const items = hasMore ? replies.slice(0, limit) : replies;

      items.forEach((reply) => {
        if (reply.status) {
          reply.content = '评论已被封禁';
        }
      });

      // 获取该评论下的总回复数
      const [[{ replyCount }]] = await connection.execute('SELECT COUNT(*) AS replyCount FROM comment WHERE comment_id = ?', [commentId]);

      let nextCursor = null;
      if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1];
        const createAtStr = lastItem.createAt instanceof Date ? lastItem.createAt.toISOString() : lastItem.createAt;
        nextCursor = `${createAtStr}_${lastItem.id}`;
      }

      return {
        items,
        nextCursor,
        hasMore,
        replyCount
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
      const statement = `SELECT COUNT(*) AS totalCount FROM comment WHERE article_id = ?`;
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
      const statement = `INSERT INTO comment (user_id, article_id, content) VALUES (?, ?, ?)`;
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
      let statement;
      let params;

      if (replyId) {
        // 回复的回复
        statement = `INSERT INTO comment (user_id, article_id, comment_id, reply_id, content) VALUES (?, ?, ?, ?, ?)`;
        params = [userId, articleId, commentId, replyId, content];
      } else {
        // 回复一级评论
        statement = `INSERT INTO comment (user_id, article_id, comment_id, content) VALUES (?, ?, ?, ?)`;
        params = [userId, articleId, commentId, content];
      }

      const [result] = await connection.execute(statement, params);

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
      const statement = `
        SELECT 
          c.id,
          c.content,
          c.status,
          c.comment_id AS cid,
          c.reply_id AS rid,
          c.article_id AS articleId,
          c.create_at AS createAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) AS author,
          (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) AS likes,
          (SELECT JSON_OBJECT('id', ru.id, 'name', ru.name, 'content', rc.content) 
           FROM comment rc 
           LEFT JOIN user ru ON ru.id = rc.user_id 
           WHERE rc.id = c.reply_id) AS replyTo
        FROM comment c
        LEFT JOIN user u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE c.id = ?
      `;

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
