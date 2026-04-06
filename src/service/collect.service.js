const connection = require('@/app/database');
const SqlUtils = require('@/utils/SqlUtils');
const BusinessError = require('@/errors/BusinessError');
const {
  buildAddCollectSql,
  buildGetCollectArticleSql,
  buildGetCollectListExecuteParams,
  buildGetCollectListSql,
} = require('./collect.sql');

class CollectService {
  addCollect = async (userId, name) => {
    const statement = buildAddCollectSql(connection.dialect);
    const [result] = await connection.execute(statement, [userId, name]);
    return result;
  };

  getCollectByName = async (userId, name) => {
    const statement = `SELECT * FROM collect WHERE user_id = ? and name = ?;`;
    const [result] = await connection.execute(statement, [userId, name]);
    return result[0];
  };

  getCollectList = async (userId, offset, limit) => {
    const statement = buildGetCollectListSql(connection.dialect);
    const executeParams = buildGetCollectListExecuteParams(connection.dialect, userId, String(offset), String(limit));
    const [result] = await connection.execute(statement, executeParams);
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

  // 优化：先DELETE再INSERT策略，减少数据库查询
  toggleCollect = async (articleId, collectId) => {
    // 先尝试删除（如果已收藏，删除会成功）
    const deleteStmt = `DELETE FROM article_collect WHERE article_id = ? AND collect_id = ?;`;
    const [deleteResult] = await connection.execute(deleteStmt, [articleId, collectId]);

    // 如果删除了行，说明之前已收藏，现在取消
    if (deleteResult.affectedRows > 0) {
      return { isCollected: false, action: 'uncollected' };
    }

    // 如果没删除任何行，说明之前未收藏，现在添加
    const insertStmt = `INSERT INTO article_collect (article_id, collect_id) VALUES (?, ?);`;
    await connection.execute(insertStmt, [articleId, collectId]);
    return { isCollected: true, action: 'collected' };
  };

  removeCollectArticle = async (idList) => {
    if (!idList || idList.length === 0) return null;
    const statement = `DELETE FROM article_collect WHERE ${SqlUtils.queryIn('article_id', idList)};`;
    const [result] = await connection.execute(statement, idList);
    return result;
  };

  getCollectArticle = async (collectId) => {
    const statement = buildGetCollectArticleSql(connection.dialect);
    const [result] = await connection.execute(statement, [collectId]);
    return result[0];
  };

  // 修改收藏夹名称
  updateCollect = async (collectId, name) => {
    const statement = `UPDATE collect SET name = ? WHERE id = ?;`;
    const [result] = await connection.execute(statement, [name, collectId]);
    return result;
  };

  // 删除收藏夹（同时删除关联的文章收藏记录）
  removeCollect = async (collectId) => {
    // 先删除关联表数据
    await connection.execute(`DELETE FROM article_collect WHERE collect_id = ?;`, [collectId]);
    // 再删除收藏夹
    const statement = `DELETE FROM collect WHERE id = ?;`;
    const [result] = await connection.execute(statement, [collectId]);
    return result;
  };
}

module.exports = new CollectService();
