const connection = require('@/app/database');
const { baseURL, redirectURL } = require('@/constants/urls');
const SqlUtils = require('@/utils/SqlUtils');
const BusinessError = require('@/errors/BusinessError');

class ArticleService {
  /**
   * 新增文章
   * 重构说明：移除 try-catch，让数据库错误自然抛出，由全局中间件统一处理
   */
  addArticle = async (userId, title, content) => {
    const statement = 'INSERT INTO article (user_id,title, content) VALUES (?,?,?);';
    const [result] = await connection.execute(statement, [userId, title, content]);
    return result;
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
    const statement = `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at createAt,
          a.update_at updateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author,
          (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes, -- 点赞数子查询
          (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount, -- 评论数子查询
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', tag.id, 'name', tag.name))
              FROM article_tag ag
              LEFT JOIN tag ON tag.id = ag.tag_id
              WHERE ag.article_id = a.id) tags, -- 标签列表子查询
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', f.id, 'url', CONCAT('${baseURL}/article/images/', f.filename)))
              FROM file f
              WHERE f.article_id = a.id) images, -- 图片列表子查询
          CONCAT('${redirectURL}/article/', a.id) articleUrl
      FROM article a
      LEFT JOIN user u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE a.id = ?;
    `;
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

    let queryByTag = tagId ? `WHERE tag.id = ?` : `WHERE 1=1`;
    let queryByUserId = userId ? `AND a.user_id = ?` : '';
    let queryByCollectId = SqlUtils.queryIn('a.id', idList, 'AND');
    let queryByTitle = keywords ? `AND a.title LIKE ?` : '';
    let listOrder = `ORDER BY ${pageOrder === 'date' ? 'a.create_at' : 'likes+a.views+commentCount'} DESC`;

    const queryParams = [];
    if (tagId) queryParams.push(tagId);
    if (userId) queryParams.push(userId);
    if (idList.length) queryParams.push(...idList);
    if (keywords) queryParams.push(`%${keywords}%`);

    const statement = `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at createAt,
          a.update_at updateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career) author,
          (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes, -- ⚠️ 相关子查询：每行执行一次
          (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount, -- ⚠️ 相关子查询：每行执行一次
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', tag.id, 'name', tag.name))
              FROM article_tag ag
              LEFT JOIN tag ON tag.id = ag.tag_id
              WHERE ag.article_id = a.id) tags, -- ⚠️ 相关子查询：每行执行一次
          (SELECT CONCAT('${baseURL}/article/images/', f.filename, '?type=small')
              FROM file f
              LEFT JOIN image_meta im ON f.id = im.file_id
              WHERE f.article_id = a.id AND f.file_type = 'image' AND im.is_cover = TRUE
              LIMIT 1) cover, -- ⚠️ 相关子查询：每行执行一次
          CONCAT('${redirectURL}/article/', a.id) articleUrl
      FROM article a
      LEFT JOIN user u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN article_tag ag ON a.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle}
      GROUP BY a.id
      ${listOrder}
      LIMIT ?, ?;
    `;
    const [result] = await connection.execute(statement, queryParams.concat(offset, limit));
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
    // ✅ 使用子查询方式筛选 tag，避免 JOIN 导致的重复行
    let queryByTag = tagId ? `AND a.id IN (SELECT article_id FROM article_tag WHERE tag_id = ?)` : '';
    let queryByUserId = userId ? `AND a.user_id = ?` : '';
    let queryByCollectId = SqlUtils.queryIn('a.id', idList, 'AND');
    let queryByTitle = keywords ? `AND a.title LIKE ?` : '';
    let listOrder = `ORDER BY ${pageOrder === 'date' ? 'a.create_at' : 'COALESCE(likes_agg.likes, 0)+a.views+COALESCE(comment_agg.commentCount, 0)'} DESC`;

    const queryParams = [];
    if (tagId) queryParams.push(tagId);
    if (userId) queryParams.push(userId);
    if (idList.length) queryParams.push(...idList);
    if (keywords) queryParams.push(`%${keywords}%`);

    const statement = `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at createAt,
          a.update_at updateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career) author,
          COALESCE(likes_agg.likes, 0) likes, -- ✅ 预聚合：所有文章的点赞数一次性计算
          COALESCE(comment_agg.commentCount, 0) commentCount, -- ✅ 预聚合：所有文章的评论数一次性计算
          tags_agg.tags, -- ✅ 预聚合：所有文章的标签一次性计算
          cover_agg.cover, -- ✅ 预聚合：所有文章的封面一次性查询
          CONCAT('${redirectURL}/article/', a.id) articleUrl
      FROM article a
      LEFT JOIN user u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      -- 点赞数预聚合：先按 article_id 分组统计，再 JOIN 关联
      LEFT JOIN (
          SELECT article_id, COUNT(*) likes 
          FROM article_like 
          GROUP BY article_id
      ) likes_agg ON a.id = likes_agg.article_id
      -- 评论数预聚合
      LEFT JOIN (
          SELECT article_id, COUNT(*) commentCount 
          FROM comment 
          GROUP BY article_id
      ) comment_agg ON a.id = comment_agg.article_id
      -- 标签列表预聚合
      LEFT JOIN (
          SELECT ag.article_id, JSON_ARRAYAGG(JSON_OBJECT('id', tag.id, 'name', tag.name)) tags
          FROM article_tag ag
          LEFT JOIN tag ON tag.id = ag.tag_id
          GROUP BY ag.article_id
      ) tags_agg ON a.id = tags_agg.article_id
      -- 封面图片预聚合
      LEFT JOIN (
          SELECT f.article_id, CONCAT('${baseURL}/article/images/', MAX(f.filename), '?type=small') cover
          FROM file f
          LEFT JOIN image_meta im ON f.id = im.file_id
          WHERE f.file_type = 'image' AND im.is_cover = TRUE
          GROUP BY f.article_id
      ) cover_agg ON a.id = cover_agg.article_id
      -- 💡 MAX(f.filename): 解决 only_full_group_by 错误，每个文章多个封面时取文件名最大的一个
      WHERE 1=1
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle}
      ${listOrder}
      LIMIT ?, ?;
    `;
    const [result] = await connection.execute(statement, queryParams.concat(offset, limit));
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
  update = async (title, content, articleId) => {
    const statement = `UPDATE article SET title = ?,content = ? WHERE id = ?;`;
    const [result] = await connection.execute(statement, [title, content, articleId]);
    return result;
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
    const statement = `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM article a where title LIKE ? LIMIT 0,10`;
    const [result] = await connection.execute(statement, [`%${keywords}%`]);
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
    const statement = `SELECT a.id,a.title, CONCAT('${redirectURL}/article/',a.id) articleUrl,a.views
      FROM article a
      ORDER BY a.views DESC
      LIMIT ?,?;`;
    const [result] = await connection.execute(statement, [offset, limit]);
    return result;
  };
}

module.exports = new ArticleService();
