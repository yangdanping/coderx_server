import SqlUtils from '../../utils/SqlUtils.js';

type ArticleId = string | number;
type QueryId = ArticleId | readonly string[];
type Keywords = string | readonly string[] | null | undefined;
type PageValue = string | number;

interface ArticleFilters {
  tagId?: QueryId | null;
  userId?: QueryId | null;
  idList: unknown;
  keywords?: Keywords;
}

interface ArticleListFilters extends ArticleFilters {
  pageOrder?: 'date' | 'hot';
}

function userTableExpr() {
  return '"user"';
}

function paginationClause() {
  return 'LIMIT ? OFFSET ?';
}

export function buildArticleListQueryParams(tagId: ArticleFilters['tagId'], userId: ArticleFilters['userId'], idList: ArticleFilters['idList'], keywords: Keywords) {
  const queryParams: unknown[] = [];
  if (tagId) queryParams.push(tagId);
  if (userId) queryParams.push(userId);
  // Preserve the legacy length check and spread for collected IDs supplied as JSON.
  const collectedIds = idList as Iterable<unknown> & { readonly length?: unknown };
  if (collectedIds.length) queryParams.push(...collectedIds);
  if (keywords) queryParams.push(`%${keywords}%`);
  return queryParams;
}

export function buildArticleListExecuteParams(queryParams: readonly unknown[], offset: PageValue, limit: PageValue) {
  return queryParams.concat(limit, offset);
}

export function buildAddArticleSql() {
  return 'INSERT INTO article (user_id,title, content, excerpt) VALUES (?,?,?::jsonb,?) RETURNING id;';
}

export function buildGetArticleByIdSql(baseURL: string, redirectURL: string) {
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
          jsonb_build_object('id', u.id, 'name', u.name, 'nickname', p.nickname, 'avatarUrl', p.avatar_url) author,
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

function buildPgArticleListSql(baseURL: string, redirectURL: string, { tagId, userId, idList, keywords, pageOrder }: ArticleListFilters) {
  const queryByTag = tagId ? `AND a.id IN (SELECT article_id FROM article_tag WHERE tag_id = ?)` : '';
  const queryByUserId = userId ? `AND a.user_id = ?` : '';
  const queryByCollectId = SqlUtils.queryIn('a.id', Array.isArray(idList) ? idList : undefined, 'AND');
  const queryByTitle = keywords ? `AND a.title ILIKE ?` : '';
  const listOrder = pageOrder === 'date' ? `ORDER BY a.create_at DESC` : `ORDER BY COALESCE(likes_agg.likes, 0)+a.views+COALESCE(comment_agg.commentCount, 0) DESC`;

  return `
      SELECT
          a.id,
          a.title,
          a.excerpt AS "excerpt",
          a.views,
          a.status,
          a.create_at AS "createAt",
          a.update_at AS "updateAt",
          jsonb_build_object('id', u.id, 'name', u.name, 'nickname', p.nickname, 'avatarUrl', p.avatar_url, 'sex', p.sex, 'career', p.career) author,
          COALESCE(likes_agg.likes, 0) likes,
          COALESCE(comment_agg.commentCount, 0) AS "commentCount",
          tags_agg.tags,
          cover_agg."coverFileId" AS "coverFileId",
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
          SELECT f.id AS "coverFileId"
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

export function buildGetArticleListSql(baseURL: string, redirectURL: string, { tagId, userId, idList, keywords, pageOrder }: ArticleListFilters) {
  return buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder });
}

export function buildGetArticleListOptimizedSql(baseURL: string, redirectURL: string, { tagId, userId, idList, keywords, pageOrder }: ArticleListFilters) {
  return buildPgArticleListSql(baseURL, redirectURL, { tagId, userId, idList, keywords, pageOrder });
}

export function buildGetTotalSql({ tagId, userId, idList, keywords }: ArticleFilters) {
  const queryByTag = tagId ? `WHERE tag.id = ?` : `WHERE 1=1`;
  const queryByUserId = userId ? `AND a.user_id = ?` : '';
  const queryByCollectId = SqlUtils.queryIn('a.id', Array.isArray(idList) ? idList : undefined, 'AND');
  const queryByTitle = keywords ? `AND a.title ILIKE ?` : '';

  return `
      SELECT COUNT(DISTINCT a.id) total
      FROM article a
      LEFT JOIN article_tag ag ON a.id = ag.article_id
      LEFT JOIN tag ON tag.id = ag.tag_id
      ${queryByTag}
      ${queryByUserId}
      ${queryByCollectId}
      ${queryByTitle};`;
}

export function buildGetArticlesByKeyWordsSql(redirectURL: string) {
  return `
      SELECT a.id,a.title,
      CONCAT('${redirectURL}/article/',a.id) AS "articleUrl"
      FROM article a where title ILIKE ? LIMIT ? OFFSET ?`;
}

export function buildGetArticlesByKeyWordsExecuteParams(keywords: Keywords): [pattern: string, limit: number, offset: number] {
  const pattern = `%${keywords}%`;
  return [pattern, 10, 0];
}

export function buildGetRecommendArticleListSql(redirectURL: string) {
  return `SELECT a.id,a.title, CONCAT('${redirectURL}/article/',a.id) AS "articleUrl",a.views
      FROM article a
      ORDER BY a.views DESC
      ${paginationClause()};`;
}

export function buildGetRecommendArticleListExecuteParams(offset: PageValue, limit: PageValue): [limit: PageValue, offset: PageValue] {
  return [limit, offset];
}

export function buildGetRandomTocArticleSql() {
  return `
    SELECT a.id
    FROM article a
    WHERE COALESCE(a.status, 0) = 0
      AND jsonb_array_length(
        jsonb_path_query_array(
          a.content,
          '$.content[*] ? (@.type == "heading" && (@.attrs.level == 1 || @.attrs.level == 2))'
        )
      ) >= 2
    ORDER BY random()
    LIMIT 1;
  `;
}
