function buildAddCollectSql() {
  return 'INSERT INTO collect (user_id,name) VALUES (?,?) RETURNING id;';
}

function buildGetCollectListSql() {
  return `
      SELECT
          c.id,
          c.name,
          c.user_id AS "userId",
          c.create_at AS "createAt",
          CASE WHEN COUNT(ac.article_id) > 0 THEN jsonb_agg(ac.article_id) ELSE NULL END count
      FROM collect c
      LEFT JOIN article_collect ac ON c.id = ac.collect_id
      WHERE user_id = ?
      GROUP BY c.id
      LIMIT ? OFFSET ?;
    `;
}

function buildGetCollectListExecuteParams(userId, offset, limit) {
  return [userId, limit, offset];
}

function buildGetCollectArticleSql() {
  return `
      SELECT
          jsonb_agg(ac.article_id) AS "collectedArticle"
      FROM article_collect ac
      WHERE ac.collect_id = ?;
    `;
}

module.exports = {
  buildAddCollectSql,
  buildGetCollectArticleSql,
  buildGetCollectListExecuteParams,
  buildGetCollectListSql,
};
