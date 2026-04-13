function buildAddHistorySql() {
  return `
        INSERT INTO article_history (user_id, article_id)
        VALUES (?, ?)
        ON CONFLICT (user_id, article_id) DO UPDATE SET update_at = CURRENT_TIMESTAMP;
      `;
}

function authorSelectExpr() {
  return `jsonb_build_object('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author`;
}

function paginationClause() {
  return 'LIMIT ? OFFSET ?';
}

function userTableExpr() {
  return '"user"';
}

function buildGetUserHistorySql(baseURL, redirectURL) {
  const author = authorSelectExpr();
  const limitClause = paginationClause();
  const userTable = userTableExpr();
  return `
        SELECT
            ah.id,
            ah.create_at AS "createAt",
            ah.update_at AS "updateAt",
            a.id AS "articleId",
            a.title,
            a.content,
            a.views,
            a.status,
            a.create_at AS "articleCreateAt",
            ${author},
            (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes,
            (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) AS "commentCount",
            (SELECT CONCAT('${baseURL}/article/images/', f.filename, '?type=small')
                FROM file f
                LEFT JOIN image_meta im ON f.id = im.file_id
                WHERE f.article_id = a.id AND f.file_type = 'image' AND im.is_cover = TRUE
                LIMIT 1) cover,
            CONCAT('${redirectURL}/article/', a.id) AS "articleUrl"
        FROM article_history ah
        LEFT JOIN article a ON ah.article_id = a.id
        LEFT JOIN ${userTable} u ON a.user_id = u.id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE ah.user_id = ? AND a.id IS NOT NULL
        ORDER BY ah.update_at DESC
        ${limitClause};
      `;
}

function buildUserHistoryExecuteParams(userId, offset, limit) {
  return [userId, limit, offset];
}

module.exports = {
  buildAddHistorySql,
  buildGetUserHistorySql,
  buildUserHistoryExecuteParams,
};
