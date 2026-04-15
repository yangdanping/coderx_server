const SqlUtils = require('../../utils/SqlUtils');

function userTableExpr() {
  return '"user"';
}

function paginationClause() {
  return 'LIMIT ? OFFSET ?';
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

function buildArticleListExecuteParams(queryParams, offset, limit) {
  return queryParams.concat(limit, offset);
}

function buildAddArticleSql() {
  return 'INSERT INTO article (user_id,title, content, excerpt) VALUES (?,?,?::jsonb,?) RETURNING id;';
}

function buildGetArticleByIdSql(baseURL, redirectURL) {
  return `
      SELECT
          a.id,
          a.title,
          a.content AS "contentJson",
          a.excerpt AS "excerpt",
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
              WHERE f.article_id = a.id AND (f.file_type = 'image' OR f.file_type IS NULL)) images,
          (SELECT jsonb_agg(jsonb_build_object(
              'id', f.id,
              'url', CONCAT('${baseURL}/article/video/', f.filename),
              'poster', CASE
                WHEN vm.poster IS NOT NULL THEN CONCAT('${baseURL}/article/video/', vm.poster)
                ELSE NULL
              END
          ))
              FROM file f
              LEFT JOIN video_meta vm ON f.id = vm.file_id
              WHERE f.article_id = a.id AND f.file_type = 'video') videos,
          CONCAT('${redirectURL}/article/', a.id) AS "articleUrl"
      FROM article a
      LEFT JOIN ${userTableExpr()} u ON a.user_id = u.id
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

  return `
      SELECT
          a.id,
          a.title,
          a.excerpt AS "excerpt",
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
      LEFT JOIN ${userTableExpr()} u ON a.user_id = u.id
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
      ${paginationClause()};
    `;
}

function buildGetArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder }) {
  return buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder });
}

function buildGetArticleListOptimizedSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder }) {
  return buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder });
}

function buildGetArticlesByKeyWordsSql(redirectURL) {
  return `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) AS "articleUrl"
      FROM article a where title LIKE ? LIMIT ? OFFSET ?`;
}

function buildGetArticlesByKeyWordsExecuteParams(keywords) {
  const pattern = `%${keywords}%`;
  return [pattern, 10, 0];
}

function buildGetRecommendArticleListSql(redirectURL) {
  return `SELECT a.id,a.title, CONCAT('${redirectURL}/article/',a.id) AS "articleUrl",a.views
      FROM article a
      ORDER BY a.views DESC
      ${paginationClause()};`;
}

function buildGetRecommendArticleListExecuteParams(offset, limit) {
  return [limit, offset];
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
