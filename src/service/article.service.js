const connection = require('@/app/database');
const { baseURL, redirectURL } = require('@/constants/urls');
const SqlUtils = require('@/utils/SqlUtils');
const BusinessError = require('@/errors/BusinessError');
const {
  buildAddArticleSql,
  buildArticleListExecuteParams,
  buildArticleListQueryParams,
  buildGetArticleByIdSql,
  buildGetArticleListOptimizedSql,
  buildGetArticleListSql,
  buildGetArticlesByKeyWordsExecuteParams,
  buildGetArticlesByKeyWordsSql,
  buildGetRecommendArticleListExecuteParams,
  buildGetRecommendArticleListSql,
} = require('./sql/article.sql');
const { buildFindDraftForConsumeSql, buildConsumeDraftSql } = require('./sql/draft.sql');

function normalizePositiveId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

function normalizeOptionalDraftId(draftId) {
  if (draftId === undefined || draftId === null || draftId === '') {
    return null;
  }

  const normalizedDraftId = normalizePositiveId(draftId);
  if (normalizedDraftId === null) {
    throw new BusinessError('参数错误: draftId 必须是正整数', 400);
  }

  return normalizedDraftId;
}

async function lockDraftForConsume(conn, { draftId, userId, articleId }) {
  const hasArticleId = articleId != null && articleId !== '';
  const statement = buildFindDraftForConsumeSql({ hasArticleId });
  const params = hasArticleId ? [draftId, userId, articleId] : [draftId, userId];
  const [rows] = await conn.execute(statement, params);
  if (!rows[0]) {
    throw new BusinessError('草稿不存在', 404);
  }
}

async function consumeDraftInTx(conn, draftId, userId, consumedArticleId) {
  const statement = buildConsumeDraftSql();
  const [meta] = await conn.execute(statement, [draftId, userId, consumedArticleId]);
  if (!meta || meta.affectedRows < 1) {
    throw new BusinessError('草稿不存在', 404);
  }
}

class ArticleService {
  /**
   * 新增文章（可选在同一事务内消费 standalone active 草稿）
   */
  addArticle = async (userId, title, content, draftId = null) => {
    const normalizedDraftId = normalizeOptionalDraftId(draftId);
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      if (normalizedDraftId != null) {
        await lockDraftForConsume(conn, { draftId: normalizedDraftId, userId, articleId: null });
      }
      const statement = buildAddArticleSql();
      const [insertResult] = await conn.execute(statement, [userId, title, content]);
      if (normalizedDraftId != null) {
        await consumeDraftInTx(conn, normalizedDraftId, userId, insertResult.insertId);
      }
      await conn.commit();
      return insertResult;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  };

  /**
   * 增加浏览量
   *
   * 🧪 测试开关：切换下面两行 SQL 来验证全局错误中间件
   * - 正确 SQL：UPDATE article SET views = views + 1 WHERE id = ?
   * - 错误 SQL：故意拼错表名 "articl"（少个 e），触发数据库错误
   */
  addView = async (articleId) => {
    // ✅ 正确的 SQL（生产环境使用）
    const statement = 'UPDATE article SET views = views + 1 WHERE id = ?;';

    // ❌ 错误的 SQL（测试用：表名拼错，会触发 ER_NO_SUCH_TABLE 错误）
    // const statement = 'UPDATE articl SET views = views + 1 WHERE id = ?;';

    const [result] = await connection.execute(statement, [articleId]);
    return result;
  };

  /**
   * 根据 ID 获取文章详情
   * 重构说明：查询结果为空时抛出 BusinessError，便于 Controller 统一处理
   */
  getArticleById = async (articleId) => {
    const statement = buildGetArticleByIdSql(baseURL, redirectURL);
    const [result] = await connection.execute(statement, [articleId]);

    if (!result[0]) {
      throw new BusinessError('文章不存在', 404);
    }
    return result[0];
  };
  /**
   * 通过性能对比测试开关：切换getArticleList和getArticleListOptimized方法来对比性能差异
   */
  getArticleList = async (offset, limit, tagId = '', userId = '', pageOrder = 'date', idList = [], keywords = '') => {
    // return await this.getArticleListOptimized(offset, limit, tagId, userId, pageOrder, idList, keywords); // 🔧 取消注释以使用优化版本

    const queryParams = buildArticleListQueryParams(tagId, userId, idList, keywords);
    const statement = buildGetArticleListSql(baseURL, redirectURL, {
      tagId,
      userId,
      idList,
      keywords,
      pageOrder,
    });
    const executeParams = buildArticleListExecuteParams(queryParams, offset, limit);
    const [result] = await connection.execute(statement, executeParams);
    return result;
  };

  /**
   * ✅ 优化版本：使用 LEFT JOIN + 预聚合替代相关子查询
   *
   * 核心优化点：
   * 1. 将 4 个相关子查询改为预聚合 + LEFT JOIN
   * 2. 聚合查询只执行一次，然后通过 JOIN 关联结果
   * 3. 性能提升：O(n²) → O(n)，在大数据量下差异明显
   *
   * 性能对比（假设 20 条文章）：
   * - 旧版：1 + 20×4 = 81 次查询
   * - 新版：1 + 4 = 5 次查询（主查询 + 4 个预聚合子查询）
   */
  getArticleListOptimized = async (offset, limit, tagId = '', userId = '', pageOrder = 'date', idList = [], keywords = '') => {
    const queryParams = buildArticleListQueryParams(tagId, userId, idList, keywords);
    const statement = buildGetArticleListOptimizedSql(baseURL, redirectURL, {
      tagId,
      userId,
      idList,
      keywords,
      pageOrder,
    });
    const executeParams = buildArticleListExecuteParams(queryParams, offset, limit);
    const [result] = await connection.execute(statement, executeParams);
    return result;
  };

  getTotal = async (tagId = '', userId = '', idList = [], keywords = '') => {
    let queryByTag = tagId ? `WHERE tag.id = ?` : `WHERE 1=1`;
    let queryByUserId = userId ? `AND a.user_id = ?` : '';
    let queryByCollectId = SqlUtils.queryIn('a.id', idList, 'AND');
    let queryByTitle = keywords ? `AND a.title LIKE ?` : '';

    const queryParams = [];
    if (tagId) queryParams.push(tagId);
    if (userId) queryParams.push(userId);
    if (idList.length) queryParams.push(...idList);
    if (keywords) queryParams.push(`%${keywords}%`);

    const statement = `
      SELECT COUNT(DISTINCT a.id) total
      FROM article a
      LEFT JOIN article_tag ag ON a.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle};`;
    const [result] = await connection.execute(statement, queryParams);
    const { total } = result[0];
    return total;
  };
  update = async (userId, title, content, articleId, draftId = null) => {
    const normalizedDraftId = normalizeOptionalDraftId(draftId);
    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      if (normalizedDraftId != null) {
        await lockDraftForConsume(conn, { draftId: normalizedDraftId, userId, articleId });
      }
      const statement = `UPDATE article SET title = ?,content = ? WHERE id = ?;`;
      const [result] = await conn.execute(statement, [title, content, articleId]);
      if (result.affectedRows < 1) {
        throw new BusinessError('文章不存在', 404);
      }
      if (normalizedDraftId != null) {
        await consumeDraftInTx(conn, normalizedDraftId, userId, articleId);
      }
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  };
  delete = async (articleId) => {
    // 获取独立连接以支持事务
    const conn = await connection.getConnection();
    let imagesToDelete = [];
    let videosToDelete = [];

    try {
      // 开始事务
      await conn.beginTransaction();

      // 1. 先查询需要删除的图片文件列表（用于后续删除磁盘文件）
      const statement1 = "SELECT filename FROM file WHERE article_id = ? AND (file_type = 'image' OR file_type IS NULL);";
      const [images] = await conn.execute(statement1, [articleId]);
      imagesToDelete = images;

      // 2. 查询需要删除的视频文件列表（包括封面）
      const statement2 = `
        SELECT f.filename, vm.poster
        FROM file f
        LEFT JOIN video_meta vm ON f.id = vm.file_id
        WHERE f.article_id = ? AND f.file_type = 'video';
      `;
      const [videos] = await conn.execute(statement2, [articleId]);
      videosToDelete = videos;

      console.log(`删除文章 ${articleId}:`, {
        图片数量: imagesToDelete.length,
        视频数量: videosToDelete.length,
      });

      // 3. 先删除 file 表中的所有关联记录（包括图片和视频）
      const statement3 = 'DELETE FROM file WHERE article_id = ?;';
      await conn.execute(statement3, [articleId]);

      // 4. 删除文章（数据库会自动级联删除其他关联表：article_tag、article_like、article_collect、comment 等）
      const statement4 = 'DELETE FROM article WHERE id = ?;';
      const [result] = await conn.execute(statement4, [articleId]);

      // 5. 提交事务
      await conn.commit();

      return { result, imagesToDelete, videosToDelete }; // 返回结果和需要删除的文件列表
    } catch (error) {
      // 回滚事务
      await conn.rollback();
      console.error('删除文章失败:', error);
      throw error;
    } finally {
      // 释放连接
      conn.release();
    }
  };
  hasTag = async (articleId, tagId) => {
    const statement = `SELECT * FROM article_tag WHERE article_id = ? AND tag_id = ?;`;
    const [result] = await connection.execute(statement, [articleId, tagId]);
    return !!result[0];
  };
  addTag = async (articleId, tagId) => {
    const statement = `INSERT INTO article_tag (article_id,tag_id) VALUES (?,?);`;
    const [result] = await connection.execute(statement, [articleId, tagId]);
    return result;
  };
  clearTag = async (articleId) => {
    const statement = `DELETE FROM article_tag WHERE article_id = ?;`;
    const [result] = await connection.execute(statement, [articleId]);
    return result;
  };
  /**
   * 重构说明：
   * 1. 批量插入使用 (?, ?) 占位符。
   * 2. 将数据展开为一维数组传递给 execute，确保安全性。
   */
  batchAddTags = async (articleId, tagIds) => {
    if (!tagIds || tagIds.length === 0) return null;
    const placeholders = tagIds.map(() => '(?, ?)').join(',');
    const queryParams = [];
    tagIds.forEach((tagId) => {
      queryParams.push(articleId, tagId);
    });
    const statement = `INSERT INTO article_tag (article_id,tag_id) VALUES ${placeholders};`;
    const [result] = await connection.execute(statement, queryParams);
    return result;
  };

  // getArticlesByKeyWords = async (keywords) => {
  //   try {
  //     const statement = `
  //     SELECT a.id,a.title,
  //     CONCAT('${redirectURL}/article/',a.id) articleUrl
  //     FROM article a where title LIKE '%${keywords}%' LIMIT 0,10`;
  //     const [result] = await connection.execute(statement);
  //     console.log('result', result);
  //     return result;
  //   } catch (error) {
  //     console.log(error);
  //   }
  // };

  /**
   * 重构说明：
   * 1. 使用 ? 占位符处理 LIKE 查询。
   */
  getArticlesByKeyWords = async (keywords) => {
    const statement = buildGetArticlesByKeyWordsSql(redirectURL);
    const params = buildGetArticlesByKeyWordsExecuteParams(keywords);
    const [result] = await connection.execute(statement, params);
    return result;
  };
  findFileById = async (articleId) => {
    const statement = `SELECT f.filename FROM file f WHERE f.article_id = ?;`;
    const [result] = await connection.execute(statement, [articleId]);
    return result;
  };
  getArticleLikedById = async (articleId) => {
    const statement = `SELECT COUNT(al.user_id) likes FROM article a
      LEFT JOIN article_like al ON a.id = al.article_id
      WHERE a.id = ?;`;
    const [result] = await connection.execute(statement, [articleId]);
    return result[0];
  };
  getRecommendArticleList = async (offset, limit) => {
    const statement = buildGetRecommendArticleListSql(redirectURL);
    const params = buildGetRecommendArticleListExecuteParams(offset, limit);
    const [result] = await connection.execute(statement, params);
    return result;
  };
}

module.exports = new ArticleService();
