export function buildAddCollectSql() {
  return 'INSERT INTO collect (user_id,name) VALUES (?,?) RETURNING id;';
}

export function buildGetCollectListSql() {
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

export function buildGetCollectListExecuteParams(userId: number | string, offset: string, limit: string): [userId: number | string, limit: string, offset: string] {
  return [userId, limit, offset];
}

export function buildGetCollectArticleSql() {
  return `
      SELECT
          jsonb_agg(ac.article_id) AS "collectedArticle"
      FROM article_collect ac
      WHERE ac.collect_id = ?;
    `;
}
