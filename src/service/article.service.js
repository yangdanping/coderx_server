const { connection } = require('../app');
const { baseURL, redirectURL } = require('../constants/urls');
const Utils = require('../utils');
const SqlUtils = require('../utils/SqlUtils');

class ArticleService {
  addArticle = async (userId, title, content) => {
    try {
      const statement = 'INSERT INTO article (user_id,title, content) VALUES (?,?,?);';
      const [result] = await connection.execute(statement, [userId, title, content]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  addView = async (articleId) => {
    try {
      const statement = 'UPDATE article set views = views + 1 WHERE id = ?;';
      const [result] = await connection.execute(statement, [articleId]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  getArticleById = async (articleId) => {
    try {
      // const statement = 'SELECT * FROM article WHERE id = ?;';
      const statement = `
      SELECT a.id,a.title,a.content,a.views,a.status,a.create_at createAt,a.update_at updateAt,
      JSON_OBJECT('id',u.id,'name',u.name,'avatarUrl',p.avatar_url) author,
      (SELECT COUNT(al.user_id) FROM article
      LEFT JOIN article_like al ON article.id = al.article_id
      WHERE article.id = a.id) likes,
      (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount,
      IF(COUNT(tag.id),(
      SELECT JSON_ARRAYAGG(JSON_OBJECT('id',tag.id,'name',tag.name)) FROM article
      LEFT JOIN article_tag ag ON article.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      WHERE article.id =a.id
      ),NULL) tags,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id',file.id,'url',CONCAT('${baseURL}/article/images/',file.filename))) FROM file WHERE a.id = file.article_id) images,
      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM article a
      LEFT JOIN user u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN article_tag ag ON a.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      WHERE a.id = ?
      GROUP BY a.id;`;
      const [result] = await connection.execute(statement, [articleId]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result[0]; //result就是我们真实查询结果,由于查询单个取第一个结果即可
    } catch (error) {
      console.log(error);
    }
  };
  /**
   * 重构说明：
   * 1. 采用与 getTotal 相同的占位符策略，彻底消除字符串拼接带来的注入风险。
   * 2. 动态维护 queryParams 数组，并将 offset 和 limit 追加到末尾。
   */
  getArticleList = async (offset, limit, tagId = '', userId = '', pageOrder = 'date', idList = [], keywords = '') => {
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

    try {
      const statement = `
      SELECT a.id,a.title,a.content,a.views,a.status,a.create_at createAt,a.update_at updateAt,
      JSON_OBJECT('id',u.id,'name',u.name,'avatarUrl',p.avatar_url,'sex',p.sex,'career',p.career) author,
      (SELECT COUNT(al.user_id) FROM article
      LEFT JOIN article_like al ON article.id = al.article_id
      WHERE article.id = a.id) likes,
      (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount,
      IF(COUNT(tag.id),(
      SELECT JSON_ARRAYAGG(JSON_OBJECT('id',tag.id,'name',tag.name)) FROM article
      LEFT JOIN article_tag ag ON article.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      WHERE article.id =a.id
      ),NULL) tags,
      (SELECT CONCAT('${baseURL}/article/images/',f.filename,'?type=small') 
       FROM file f 
       LEFT JOIN image_meta im ON f.id = im.file_id 
       WHERE f.article_id = a.id AND f.file_type = 'image' AND im.is_cover = TRUE 
       LIMIT 1) cover,
      CONCAT('${redirectURL}/article/',a.id) articleUrl
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
      LIMIT ?,?;`;
      const [result] = await connection.execute(statement, queryParams.concat(offset, limit));
      return result;
    } catch (error) {
      console.log(error);
    }
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

    try {
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
    } catch (error) {
      console.log(error);
    }
  };
  update = async (title, content, articleId) => {
    try {
      const statement = `UPDATE article SET title = ?,content = ? WHERE id = ?;`;
      const [result] = await connection.execute(statement, [title, content, articleId]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result;
    } catch (error) {
      console.log(error);
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
    try {
      const statement = `SELECT * FROM article_tag WHERE article_id = ? AND tag_id = ?;`;
      const [result] = await connection.execute(statement, [articleId, tagId]);
      return result[0] ? true : false;
    } catch (error) {
      console.log(error);
    }
  };
  addTag = async (articleId, tagId) => {
    try {
      const statement = `INSERT INTO article_tag (article_id,tag_id) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [articleId, tagId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  clearTag = async (articleId) => {
    try {
      const statement = `DELETE FROM article_tag WHERE article_id = ?;`;
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  /**
   * 重构说明：
   * 1. 批量插入使用 (?, ?) 占位符。
   * 2. 将数据展开为一维数组传递给 execute，确保安全性。
   */
  batchAddTags = async (articleId, tagIds) => {
    if (!tagIds || tagIds.length === 0) return null;
    try {
      const placeholders = tagIds.map(() => '(?, ?)').join(','); // 最终形成 (?, ?), (?, ?),...
      const queryParams = [];
      tagIds.forEach((tagId) => {
        queryParams.push(articleId, tagId);
      });
      const statement = `INSERT INTO article_tag (article_id,tag_id) VALUES ${placeholders};`;
      const [result] = await connection.execute(statement, queryParams);
      return result;
    } catch (error) {
      console.log(error);
    }
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
    try {
      const statement = `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM article a where title LIKE ? LIMIT 0,10`;
      const [result] = await connection.execute(statement, [`%${keywords}%`]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  findFileById = async (articleId) => {
    try {
      const statement = `SELECT f.filename FROM file f WHERE f.article_id = ?;`;
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  getArticleLikedById = async (articleId) => {
    try {
      const statement = `SELECT COUNT(al.user_id) likes FROM article a
      LEFT JOIN article_like al ON a.id = al.article_id
      WHERE a.id = ?;`;
      const [result] = await connection.execute(statement, [articleId]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  };
  getRecommendArticleList = async (offset, limit) => {
    try {
      const statement = `SELECT a.id,a.title, CONCAT('${redirectURL}/article/',a.id) articleUrl,a.views
      FROM article a
      ORDER BY a.views DESC
      LIMIT ?,?;`;
      const [result] = await connection.execute(statement, [offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
}

module.exports = new ArticleService();
