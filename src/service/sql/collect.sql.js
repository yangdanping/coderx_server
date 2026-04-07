function paginationClause(dialect) {
  return dialect === 'pg' ? 'LIMIT ? OFFSET ?' : 'LIMIT ?, ?';
}

function paginateParams(dialect, baseParams, offset, limit) {
  if (dialect === 'pg') {
    return baseParams.concat(limit, offset);
  }

  return baseParams.concat(offset, limit);
}

function buildAddCollectSql(dialect) {
  return dialect === 'pg'
    ? 'INSERT INTO collect (user_id,name) VALUES (?,?) RETURNING id;'
    : 'INSERT INTO collect (user_id,name) VALUES (?,?);';
}

function buildGetCollectListSql(dialect) {
  if (dialect === 'pg') {
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
      ${paginationClause(dialect)};
    `;
  }

  return `
      SELECT
          c.id,
          c.name,
          c.user_id userId,
          c.create_at createAt,
          IF(COUNT(ac.article_id), JSON_ARRAYAGG(ac.article_id), NULL) count
      FROM collect c
      LEFT JOIN article_collect ac ON c.id = ac.collect_id
      WHERE user_id = ?
      GROUP BY c.id
      ${paginationClause(dialect)};
    `;
}

function buildGetCollectListExecuteParams(dialect, userId, offset, limit) {
  return paginateParams(dialect, [userId], offset, limit);
}

function buildGetCollectArticleSql(dialect) {
  if (dialect === 'pg') {
    return `
      SELECT
          jsonb_agg(ac.article_id) AS "collectedArticle"
      FROM article_collect ac
      WHERE ac.collect_id = ?;
    `;
  }

  return `
      SELECT
          JSON_ARRAYAGG(ac.article_id) collectedArticle
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
