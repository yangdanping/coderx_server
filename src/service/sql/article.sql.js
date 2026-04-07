const SqlUtils = require('../../utils/SqlUtils');

function userTableExpr(dialect) {
  return dialect === 'pg' ? '"user"' : 'user';
}

function paginationClause(dialect) {
  return dialect === 'pg' ? 'LIMIT ? OFFSET ?' : 'LIMIT ?, ?';
}

/** @param {string} tagId @param {string} userId @param {unknown[]} idList @param {string} keywords */
function buildArticleListQueryParams(tagId, userId, idList, keywords) {
  const queryParams = [];
  if (tagId) queryParams.push(tagId);
  if (userId) queryParams.push(userId);
  if (idList.length) queryParams.push(...idList);
  if (keywords) queryParams.push(`%${keywords}%`);
  return queryParams;
}

function buildArticleListExecuteParams(dialect, queryParams, offset, limit) {
  if (dialect === 'pg') {
    return queryParams.concat(limit, offset);
  }
  return queryParams.concat(offset, limit);
}

function buildAddArticleSql(dialect) {
  const returning = dialect === 'pg' ? ' RETURNING id' : '';
  return `INSERT INTO article (user_id,title, content) VALUES (?,?,?)${returning};`;
}

function buildGetArticleByIdSql(dialect, baseURL, redirectURL) {
  const userTable = userTableExpr(dialect);
  if (dialect === 'pg') {
    return `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at AS "createAt",
          a.update_at AS "updateAt",
          jsonb_build_object('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author,
          (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes,
          (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) AS "commentCount",
          (SELECT jsonb_agg(jsonb_build_object('id', tag.id, 'name', tag.name))
              FROM article_tag ag
              LEFT JOIN tag ON tag.id = ag.tag_id
              WHERE ag.article_id = a.id AND tag.id IS NOT NULL) tags,
          (SELECT jsonb_agg(jsonb_build_object('id', f.id, 'url', CONCAT('${baseURL}/article/images/', f.filename)))
              FROM file f
              WHERE f.article_id = a.id) images,
          CONCAT('${redirectURL}/article/', a.id) AS "articleUrl"
      FROM article a
      LEFT JOIN ${userTable} u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE a.id = ?;
    `;
  }
  return `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at createAt,
          a.update_at updateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author,
          (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes,
          (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount,
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', tag.id, 'name', tag.name))
              FROM article_tag ag
              LEFT JOIN tag ON tag.id = ag.tag_id
              WHERE ag.article_id = a.id) tags,
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', f.id, 'url', CONCAT('${baseURL}/article/images/', f.filename)))
              FROM file f
              WHERE f.article_id = a.id) images,
          CONCAT('${redirectURL}/article/', a.id) articleUrl
      FROM article a
      LEFT JOIN ${userTable} u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE a.id = ?;
    `;
}

function buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder }) {
  const queryByTag = tagId ? `AND a.id IN (SELECT article_id FROM article_tag WHERE tag_id = ?)` : '';
  const queryByUserId = userId ? `AND a.user_id = ?` : '';
  const queryByCollectId = SqlUtils.queryIn('a.id', idList, 'AND');
  const queryByTitle = keywords ? `AND a.title LIKE ?` : '';
  const listOrder =
    pageOrder === 'date'
      ? `ORDER BY a.create_at DESC`
      : `ORDER BY COALESCE(likes_agg.likes, 0)+a.views+COALESCE(comment_agg.commentCount, 0) DESC`;
  const limitClause = paginationClause('pg');

  return `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at AS "createAt",
          a.update_at AS "updateAt",
          jsonb_build_object('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career) author,
          COALESCE(likes_agg.likes, 0) likes,
          COALESCE(comment_agg.commentCount, 0) AS "commentCount",
          tags_agg.tags,
          cover_agg.cover,
          CONCAT('${redirectURL}/article/', a.id) AS "articleUrl"
      FROM article a
      LEFT JOIN "user" u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN (
          SELECT article_id, COUNT(*) likes
          FROM article_like
          GROUP BY article_id
      ) likes_agg ON a.id = likes_agg.article_id
      LEFT JOIN (
          SELECT article_id, COUNT(*) commentCount
          FROM comment
          GROUP BY article_id
      ) comment_agg ON a.id = comment_agg.article_id
      LEFT JOIN (
          SELECT ag.article_id, jsonb_agg(jsonb_build_object('id', tag.id, 'name', tag.name)) FILTER (WHERE tag.id IS NOT NULL) tags
          FROM article_tag ag
          LEFT JOIN tag ON tag.id = ag.tag_id
          GROUP BY ag.article_id
      ) tags_agg ON a.id = tags_agg.article_id
      LEFT JOIN LATERAL (
          SELECT CONCAT('${baseURL}/article/images/', f.filename, '?type=small') cover
          FROM file f
          LEFT JOIN image_meta im ON f.id = im.file_id
          WHERE f.article_id = a.id AND f.file_type = 'image' AND im.is_cover = TRUE
          LIMIT 1
      ) cover_agg ON TRUE
      WHERE 1=1
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle}
      ${listOrder}
      ${limitClause};
    `;
}

function buildGetArticleListSql(dialect, baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder }) {
  if (dialect === 'pg') {
    return buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder });
  }

  const userTable = userTableExpr(dialect);
  let queryByTag = tagId ? `WHERE tag.id = ?` : `WHERE 1=1`;
  let queryByUserId = userId ? `AND a.user_id = ?` : '';
  let queryByCollectId = SqlUtils.queryIn('a.id', idList, 'AND');
  let queryByTitle = keywords ? `AND a.title LIKE ?` : '';
  let listOrder = `ORDER BY ${pageOrder === 'date' ? 'a.create_at' : 'likes+a.views+commentCount'} DESC`;
  const limitClause = paginationClause('mysql');

  return `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at createAt,
          a.update_at updateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career) author,
          (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes,
          (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount,
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', tag.id, 'name', tag.name))
              FROM article_tag ag
              LEFT JOIN tag ON tag.id = ag.tag_id
              WHERE ag.article_id = a.id) tags,
          (SELECT CONCAT('${baseURL}/article/images/', f.filename, '?type=small')
              FROM file f
              LEFT JOIN image_meta im ON f.id = im.file_id
              WHERE f.article_id = a.id AND f.file_type = 'image' AND im.is_cover = TRUE
              LIMIT 1) cover,
          CONCAT('${redirectURL}/article/', a.id) articleUrl
      FROM article a
      LEFT JOIN ${userTable} u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN article_tag ag ON a.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle}
      GROUP BY a.id
      ${listOrder}
      ${limitClause};
    `;
}

function buildGetArticleListOptimizedSql(dialect, baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder }) {
  if (dialect === 'pg') {
    return buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder });
  }

  const userTable = userTableExpr(dialect);
  let queryByTag = tagId ? `AND a.id IN (SELECT article_id FROM article_tag WHERE tag_id = ?)` : '';
  let queryByUserId = userId ? `AND a.user_id = ?` : '';
  let queryByCollectId = SqlUtils.queryIn('a.id', idList, 'AND');
  let queryByTitle = keywords ? `AND a.title LIKE ?` : '';
  let listOrder = `ORDER BY ${pageOrder === 'date' ? 'a.create_at' : 'COALESCE(likes_agg.likes, 0)+a.views+COALESCE(comment_agg.commentCount, 0)'} DESC`;
  const limitClause = paginationClause('mysql');

  return `
      SELECT
          a.id,
          a.title,
          a.content,
          a.views,
          a.status,
          a.create_at createAt,
          a.update_at updateAt,
          JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career) author,
          COALESCE(likes_agg.likes, 0) likes,
          COALESCE(comment_agg.commentCount, 0) commentCount,
          tags_agg.tags,
          cover_agg.cover,
          CONCAT('${redirectURL}/article/', a.id) articleUrl
      FROM article a
      LEFT JOIN ${userTable} u ON a.user_id = u.id
      LEFT JOIN profile p ON u.id = p.user_id
      LEFT JOIN (
          SELECT article_id, COUNT(*) likes
          FROM article_like
          GROUP BY article_id
      ) likes_agg ON a.id = likes_agg.article_id
      LEFT JOIN (
          SELECT article_id, COUNT(*) commentCount
          FROM comment
          GROUP BY article_id
      ) comment_agg ON a.id = comment_agg.article_id
      LEFT JOIN (
          SELECT ag.article_id, JSON_ARRAYAGG(JSON_OBJECT('id', tag.id, 'name', tag.name)) tags
          FROM article_tag ag
          LEFT JOIN tag ON tag.id = ag.tag_id
          GROUP BY ag.article_id
      ) tags_agg ON a.id = tags_agg.article_id
      LEFT JOIN (
          SELECT f.article_id, CONCAT('${baseURL}/article/images/', MAX(f.filename), '?type=small') cover
          FROM file f
          LEFT JOIN image_meta im ON f.id = im.file_id
          WHERE f.file_type = 'image' AND im.is_cover = TRUE
          GROUP BY f.article_id
      ) cover_agg ON a.id = cover_agg.article_id
      WHERE 1=1
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle}
      ${listOrder}
      ${limitClause};
    `;
}

function buildGetArticlesByKeyWordsSql(dialect, redirectURL) {
  if (dialect === 'pg') {
    return `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) AS "articleUrl"
      FROM article a where title LIKE ? LIMIT ? OFFSET ?`;
  }
  return `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) articleUrl
      FROM article a where title LIKE ? LIMIT 0,10`;
}

function buildGetArticlesByKeyWordsExecuteParams(dialect, keywords) {
  const pattern = `%${keywords}%`;
  if (dialect === 'pg') {
    return [pattern, 10, 0];
  }
  return [pattern];
}

function buildGetRecommendArticleListSql(dialect, redirectURL) {
  const limitClause = paginationClause(dialect);
  const articleUrlExpr =
    dialect === 'pg'
      ? `CONCAT('${redirectURL}/article/',a.id) AS "articleUrl"`
      : `CONCAT('${redirectURL}/article/',a.id) articleUrl`;
  return `SELECT a.id,a.title, ${articleUrlExpr},a.views
      FROM article a
      ORDER BY a.views DESC
      ${limitClause};`;
}

function buildGetRecommendArticleListExecuteParams(dialect, offset, limit) {
  if (dialect === 'pg') {
    return [limit, offset];
  }
  return [offset, limit];
}

module.exports = {
  buildAddArticleSql,
  buildArticleListExecuteParams,
  buildArticleListQueryParams,
  buildGetArticleByIdSql,
  buildGetArticleListOptimizedSql,
  buildGetArticleListSql,
  buildGetArticlesByKeyWordsExecuteParams,
  buildGetArticlesByKeyWordsSql,
  buildGetRecommendArticleListExecuteParams,
  buildGetRecommendArticleListSql,
};
