const USER_TABLE = '"user"';

function buildGetUserByNameSql() {
  return `SELECT * FROM ${USER_TABLE} WHERE name = ?;`;
}

function buildGetProfileByIdSql() {
  return `
      SELECT
          u.id,
          u.name,
          u.status,
          p.avatar_url AS "avatarUrl",
          p.age,
          p.sex,
          p.email,
          p.career,
          p.address,
          (SELECT COUNT(*) FROM article a WHERE a.user_id = u.id) AS "articleCount",
          (SELECT COUNT(*) FROM comment c WHERE c.user_id = u.id) AS "commentCount"
      FROM ${USER_TABLE} u
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE u.id = ?;
    `;
}

function buildGetCommentByIdSql() {
  return `
    SELECT c.id, a.title,c.content, c.comment_id AS "commentId", c.create_at AS "createAt",
    jsonb_build_object('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) AS "user",
    (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes
    FROM comment c
    LEFT JOIN article a ON c.article_id = a.id
    LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE u.id = ?
    ORDER BY c.update_at DESC
    LIMIT ? OFFSET ?;
    `;
}

function buildGetCommentByIdExecuteParams(userId, offset, limit) {
  return [userId, limit, offset];
}

function buildGetLikedByIdSql() {
  return `
        SELECT
            u.id,
            u.name,
            (SELECT jsonb_agg(al.article_id)
                FROM article_like al
                WHERE al.user_id = u.id) AS "articleLiked",
            (SELECT jsonb_agg(cl.comment_id)
                FROM comment_like cl
                WHERE cl.user_id = u.id) AS "commentLiked"
        FROM ${USER_TABLE} u
        WHERE u.id = ?;
      `;
}

function buildGetFollowInfoSql() {
  return `
        SELECT
            u.id,
            u.name,
            (SELECT CASE
                WHEN COUNT(*) > 0 THEN jsonb_agg(jsonb_build_object(
                    'id', fu.id,
                    'name', fu.name,
                    'avatarUrl', fp.avatar_url,
                    'sex', fp.sex,
                    'career', fp.career
                ))
                ELSE NULL
            END
                FROM user_follow uf
                LEFT JOIN ${USER_TABLE} fu ON fu.id = uf.user_id
                LEFT JOIN profile fp ON fu.id = fp.user_id
                WHERE uf.follower_id = u.id) following,
            (SELECT jsonb_agg(jsonb_build_object(
                'id', us.id,
                'name', us.name,
                'avatarUrl', pf.avatar_url,
                'sex', pf.sex,
                'career', pf.career
            ))
                FROM user_follow ufo
                LEFT JOIN ${USER_TABLE} us ON us.id = ufo.follower_id
                LEFT JOIN profile pf ON us.id = pf.user_id
                WHERE ufo.user_id = u.id) follower
        FROM ${USER_TABLE} u
        WHERE u.id = ?;
      `;
}

function buildGetArticleByCollectIdSql() {
  return `
      SELECT a.id,a.title,a.excerpt AS "excerpt",a.create_at AS "createAt"
      FROM article_collect ac
      LEFT JOIN collect c ON ac.collect_id = c.id
      LEFT JOIN article a ON ac.article_id = a.id
      WHERE c.user_id = ? AND c.id = ?
      LIMIT ? OFFSET ?;
      `;
}

function buildGetArticleByCollectIdExecuteParams(userId, collectId, offset, limit) {
  return [userId, collectId, limit, offset];
}

function buildGetHotUsersSql() {
  return `
        SELECT
            u.id,
            u.name,
            p.avatar_url AS "avatarUrl",
            p.age,
            p.sex,
            p.email,
            p.career,
            p.address,
            (SELECT jsonb_build_object('totalLikes', COUNT(al.article_id), 'totalViews', SUM(a.views))
                FROM article a
                LEFT JOIN article_like al ON a.id = al.article_id
                WHERE a.user_id = u.id) AS "articleInfo"
        FROM ${USER_TABLE} u
        LEFT JOIN profile p ON u.id = p.user_id
        ORDER BY u.id
        LIMIT 5;
      `;
}

module.exports = {
  buildGetArticleByCollectIdExecuteParams,
  buildGetArticleByCollectIdSql,
  buildGetCommentByIdExecuteParams,
  buildGetCommentByIdSql,
  buildGetFollowInfoSql,
  buildGetHotUsersSql,
  buildGetLikedByIdSql,
  buildGetProfileByIdSql,
  buildGetUserByNameSql,
};
