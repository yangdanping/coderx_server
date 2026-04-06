function userTableExpr(dialect) {
  return dialect === 'pg' ? '"user"' : 'user';
}

function paginationClause(dialect) {
  return dialect === 'pg' ? 'LIMIT ? OFFSET ?' : 'LIMIT ?, ?';
}

function paginateParams(dialect, baseParams, offset, limit) {
  if (dialect === 'pg') {
    return baseParams.concat(limit, offset);
  }
  return baseParams.concat(offset, limit);
}

function buildGetUserByNameSql(dialect) {
  return `SELECT * FROM ${userTableExpr(dialect)} WHERE name = ?;`;
}

function buildGetProfileByIdSql(dialect) {
  const userTable = userTableExpr(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);
  return `
      SELECT
          u.id,
          u.name,
          u.status,
          p.avatar_url AS ${q('avatarUrl')},
          p.age,
          p.sex,
          p.email,
          p.career,
          p.address,
          (SELECT COUNT(*) FROM article a WHERE a.user_id = u.id) AS ${q('articleCount')},
          (SELECT COUNT(*) FROM comment c WHERE c.user_id = u.id) AS ${q('commentCount')}
      FROM ${userTable} u
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE u.id = ?;
    `;
}

function buildGetCommentByIdSql(dialect) {
  if (dialect === 'pg') {
    return `
    SELECT c.id, a.title,c.content, c.comment_id AS "commentId", c.create_at AS "createAt",
    jsonb_build_object('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) AS "user",
    (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes
    FROM comment c
    LEFT JOIN article a ON c.article_id = a.id
    LEFT JOIN "user" u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE u.id = ?
    ORDER BY c.update_at DESC
    LIMIT ? OFFSET ?;
    `;
  }

  return `
    SELECT c.id, a.title,c.content, c.comment_id commentId, c.create_at createAt,
    JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) user,
    COUNT(cl.user_id) likes
    FROM comment c
    LEFT JOIN article a ON c.article_id = a.id
    LEFT JOIN user u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    LEFT JOIN comment_like cl ON c.id = cl.comment_id
    WHERE u.id = ?
    GROUP BY c.id
    ORDER BY c.update_at DESC
    LIMIT ?,?;
    `;
}

function buildGetCommentByIdExecuteParams(dialect, userId, offset, limit) {
  return paginateParams(dialect, [userId], offset, limit);
}

function buildGetLikedByIdSql(dialect) {
  if (dialect === 'pg') {
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
        FROM "user" u
        WHERE u.id = ?;
      `;
  }

  return `
        SELECT
            u.id,
            u.name,
            JSON_ARRAYAGG(al.article_id) articleLiked,
            (SELECT JSON_ARRAYAGG(cl.comment_id)
                FROM user
                LEFT JOIN comment_like cl ON user.id = cl.user_id
                WHERE user.id = u.id
                GROUP BY user.id) commentLiked
        FROM user u
        LEFT JOIN article_like al ON u.id = al.user_id
        WHERE u.id = ?
        GROUP BY u.id;
      `;
}

function buildGetFollowInfoSql(dialect) {
  if (dialect === 'pg') {
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
                LEFT JOIN "user" fu ON fu.id = uf.user_id
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
                LEFT JOIN "user" us ON us.id = ufo.follower_id
                LEFT JOIN profile pf ON us.id = pf.user_id
                WHERE ufo.user_id = u.id) follower
        FROM "user" u
        WHERE u.id = ?;
      `;
  }

  return `
        SELECT
            u.id,
            u.name,
            IF(COUNT(uf.follower_id),
                JSON_ARRAYAGG(JSON_OBJECT('id', uf.user_id, 'name',
                    (SELECT user.name FROM user WHERE user.id = uf.user_id),
                    'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career
                )),
                NULL) following,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', ufo.follower_id,
                'name', us.name, 'avatarUrl', pf.avatar_url, 'sex', pf.sex, 'career', pf.career))
                FROM user us
                LEFT JOIN user_follow ufo ON us.id = ufo.follower_id
                LEFT JOIN profile pf ON us.id = pf.user_id
                WHERE ufo.user_id = u.id
                GROUP BY ufo.user_id) follower
        FROM user u
        LEFT JOIN user_follow uf ON u.id = uf.follower_id
        LEFT JOIN profile p ON uf.user_id = p.user_id
        WHERE u.id = ?
        GROUP BY u.id;
      `;
}

function buildGetArticleByCollectIdSql(dialect) {
  const limitClause = paginationClause(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);
  return `
      SELECT a.id,a.title,a.content,a.create_at AS ${q('createAt')}
      FROM article_collect ac
      LEFT JOIN collect c ON ac.collect_id = c.id
      LEFT JOIN article a ON ac.article_id = a.id
      WHERE c.user_id = ? AND c.id = ?
      ${limitClause};
      `;
}

function buildGetArticleByCollectIdExecuteParams(dialect, userId, collectId, offset, limit) {
  return paginateParams(dialect, [userId, collectId], offset, limit);
}

function buildGetHotUsersSql(dialect) {
  if (dialect === 'pg') {
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
        FROM "user" u
        LEFT JOIN profile p ON u.id = p.user_id
        ORDER BY u.id
        LIMIT 5;
      `;
  }

  return `
        SELECT
            u.id,
            u.name,
            p.avatar_url avatarUrl,
            p.age,
            p.sex,
            p.email,
            p.career,
            p.address,
            (SELECT JSON_OBJECT('totalLikes', COUNT(al.article_id), 'totalViews', SUM(a.views))
                FROM article a
                LEFT JOIN article_like al ON a.id = al.article_id
                WHERE a.user_id = u.id) articleInfo
        FROM user u
        LEFT JOIN profile p ON u.id = p.user_id
        ORDER BY u.id
        LIMIT 0, 5;
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
