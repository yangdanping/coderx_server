const { connection } = require('../app');
const { baseURL, redirectURL } = require('../constants/urls');

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
  getArticleList = async (offset, limit, tagId = '', userId = '', order = 'date', idList = [], keywords = '') => {
    // 根据tagId查询
    let queryByTag = `WHERE tag.id ${tagId ? `= ${tagId}` : `LIKE '%%'`}`;
    // 根据用户id查询(用于查询用户发过的文章)
    let queryByUserId = userId ? `AND a.user_id = ${userId}` : '';
    // 根据文章id查询(用于文章收藏)
    let queryByCollectId = idList.length ? `AND a.id IN (${idList.join(',')})` : '';
    // 根据文章标题查询(用于文章收藏)
    let queryByTitle = keywords ? `AND a.title LIKE '%${keywords}%'` : '';
    // 文章排序
    let listOrder = `ORDER BY ${order === 'date' ? 'a.create_at' : 'likes+a.views+commentCount'} DESC`;
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
      const [result] = await connection.execute(statement, [offset, limit]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result; //result就是我们真实查询结果,由于查询单个取第一个结果即可
    } catch (error) {
      console.log(error);
    }
  };
  getTotal = async () => {
    try {
      const statement = `SELECT COUNT(a.id) total FROM article a;`;
      const [result] = await connection.execute(statement); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
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
      const statement2 = "SELECT filename, poster FROM file WHERE article_id = ? AND file_type = 'video';";
      const [videos] = await conn.execute(statement2, [articleId]);
      videosToDelete = videos;

      console.log(`删除文章 ${articleId}:`, {
        图片数量: imagesToDelete.length,
        视频数量: videosToDelete.length
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
  getArticlesByKeyWords = async (keywords) => {
    try {
      const statement = `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM article a where title LIKE '%${keywords}%' LIMIT 0,10`;
      const [result] = await connection.execute(statement);
      console.log('result', result);
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
