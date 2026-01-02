const connection = require('@/app/database');
const SqlUtils = require('@/utils/SqlUtils');
const BusinessError = require('@/errors/BusinessError');

class CollectService {
  addCollect = async (userId, name) => {
    const statement = `INSERT INTO collect (user_id,name) VALUES (?,?);`;
    const [result] = await connection.execute(statement, [userId, name]);
    return result;
  };

  getCollectByName = async (userId, name) => {
    const statement = `SELECT * FROM collect WHERE user_id = ? and name = ?;`;
    const [result] = await connection.execute(statement, [userId, name]);
    return result[0];
  };

  getCollectList = async (userId, offset, limit) => {
    const statement = `SELECT c.id, c.name,c.user_id userId,c.create_at createAt,
    IF(COUNT(ac.article_id),JSON_ARRAYAGG(ac.article_id),NULL) count
    FROM collect c
    LEFT JOIN article_collect ac
    ON c.id = ac.collect_id
    WHERE user_id = ?
    GROUP BY c.id
    LIMIT ?,?;`;
    const [result] = await connection.execute(statement, [userId, offset, limit]);
    return result;
  };

  hasCollect = async (articleId, collectId) => {
    const statement = `SELECT * FROM article_collect WHERE article_id = ? AND collect_id = ?;`;
    const [result] = await connection.execute(statement, [articleId, collectId]);
    return result[0] ? true : false;
  };

  changeCollect = async (articleId, collectId, isCollect) => {
    const statement = !isCollect ? `INSERT INTO article_collect (article_id,collect_id) VALUES (?,?);` : `DELETE FROM article_collect WHERE article_id = ? AND collect_id = ?;`;
    const [result] = await connection.execute(statement, [articleId, collectId]);
    return result;
  };

  removeCollectArticle = async (idList) => {
    if (!idList || idList.length === 0) return null;
    const statement = `DELETE FROM article_collect WHERE ${SqlUtils.queryIn('article_id', idList)};`;
    const [result] = await connection.execute(statement, idList);
    return result;
  };

  getCollectArticle = async (collectId) => {
    const statement = `SELECT JSON_ARRAYAGG(ac.article_id) collectedArticle FROM article_collect ac WHERE ac.collect_id = ?;`;
    const [result] = await connection.execute(statement, [collectId]);
    return result[0];
  };
}

module.exports = new CollectService();
