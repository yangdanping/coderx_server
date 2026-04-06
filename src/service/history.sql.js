function buildAddHistorySql(dialect) {
  if (dialect === 'pg') {
    return `
        INSERT INTO article_history (user_id, article_id)
        VALUES (?, ?)
        ON CONFLICT (user_id, article_id) DO UPDATE SET update_at = CURRENT_TIMESTAMP;
      `;
  }
  return `
        INSERT INTO article_history (user_id, article_id)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE update_at = CURRENT_TIMESTAMP;
      `;
}

function authorSelectExpr(dialect) {
  if (dialect === 'pg') {
    return `jsonb_build_object('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author`;
  }
  return `JSON_OBJECT('id', u.id, 'name', u.name, 'avatarUrl', p.avatar_url) author`;
}

function paginationClause(dialect) {
  return dialect === 'pg' ? 'LIMIT ? OFFSET ?' : 'LIMIT ?, ?';
}

function userTableExpr(dialect) {
  return dialect === 'pg' ? '"user"' : 'user';
}

function buildGetUserHistorySql(dialect, baseURL, redirectURL) {
  const author = authorSelectExpr(dialect);
  const limitClause = paginationClause(dialect);
  const userTable = userTableExpr(dialect);
  return `
        SELECT
            ah.id,
            ah.create_at createAt,
            ah.update_at updateAt,
            a.id articleId,
            a.title,
            a.content,
            a.views,
            a.status,
            a.create_at articleCreateAt,
            ${author},
            (SELECT COUNT(al.user_id) FROM article_like al WHERE al.article_id = a.id) likes, -- 点赞数子查询
            (SELECT COUNT(*) FROM comment c WHERE c.article_id = a.id) commentCount, -- 评论数子查询
            (SELECT CONCAT('${baseURL}/article/images/', f.filename, '?type=small')
                FROM file f
                LEFT JOIN image_meta im ON f.id = im.file_id
                WHERE f.article_id = a.id AND f.file_type = 'image' AND im.is_cover = TRUE
                LIMIT 1) cover, -- 封面图片子查询
            CONCAT('${redirectURL}/article/', a.id) articleUrl
        FROM article_history ah
        LEFT JOIN article a ON ah.article_id = a.id
        LEFT JOIN ${userTable} u ON a.user_id = u.id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE ah.user_id = ? AND a.id IS NOT NULL
        ORDER BY ah.update_at DESC
        ${limitClause};
      `;
}

function buildUserHistoryExecuteParams(dialect, userId, offset, limit) {
  if (dialect === 'pg') {
    return [userId, limit, offset];
  }
  return [userId, offset, limit];
}

module.exports = {
  buildAddHistorySql,
  buildGetUserHistorySql,
  buildUserHistoryExecuteParams,
};
