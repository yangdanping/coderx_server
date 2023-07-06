const { connection } = require('../app');

class CollectService {
  async addCollect(userId, name) {
    try {
      const statement = `INSERT INTO collect (user_id,name) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [userId, name]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getCollectByName(userId, name) {
    try {
      const statement = `SELECT * FROM collect WHERE user_id = ? and name = ?;`;
      const [result] = await connection.execute(statement, [userId, name]);
      return result[0]; //直接把查到的记录返回,不存在时返回的是undefined
    } catch (error) {
      console.log(error);
    }
  }

  async getCollectList(userId, offset, limit) {
    try {
      const statement = `SELECT c.id id, c.name name,c.user_id userId,c.create_at createAt,
      IF(COUNT(ac.article_id),JSON_ARRAYAGG(ac.article_id),NULL) count
      FROM collect c
      LEFT JOIN article_collect ac
      ON c.id = ac.collect_id
      WHERE user_id = ?
      GROUP BY c.id
      LIMIT ?,?;`;
      const [result] = await connection.execute(statement, [userId, offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }

  async hasCollect(articleId, collectId) {
    try {
      const statement = `SELECT * FROM article_collect WHERE article_id = ? AND collect_id = ?;`;
      const [result] = await connection.execute(statement, [articleId, collectId]);
      return result[0] ? true : false;
    } catch (error) {
      console.log(error);
    }
  }

  async changeCollect(articleId, collectId, isCollect) {
    try {
      const statement = !isCollect ? `INSERT INTO article_collect (article_id,collect_id) VALUES (?,?);` : `DELETE FROM article_collect WHERE article_id = ? AND collect_id = ?;`;
      const [result] = await connection.execute(statement, [articleId, collectId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }

  async removeCollectArticle(idList) {
    try {
      const statement = `DELETE FROM article_collect WHERE article_id IN (${idList.join(',')});`;
      const [result] = await connection.execute(statement, [idList]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getCollectArticle(collectId) {
    try {
      const statement = `SELECT JSON_ARRAYAGG(ac.article_id) collectedArticle FROM article_collect ac WHERE ac.collect_id = ?;`;
      const [result] = await connection.execute(statement, [collectId]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result[0];
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new CollectService();
