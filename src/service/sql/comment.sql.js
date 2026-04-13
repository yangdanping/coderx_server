const USER_TABLE = '"user"';

function authorSelectExpr(alias = 'u', profileAlias = 'p') {
  return `jsonb_build_object('id', ${alias}.id, 'name', ${alias}.name, 'avatarUrl', ${profileAlias}.avatar_url) author`;
}

function articleSelectExpr(alias = 'a') {
  return `jsonb_build_object('id', ${alias}.id, 'title', ${alias}.title) article`;
}

function replyToSelectExpr() {
  return `(SELECT jsonb_build_object('id', ru.id, 'name', ru.name, 'content', rc.content)
      FROM comment rc
      LEFT JOIN ${USER_TABLE} ru ON ru.id = rc.user_id
      WHERE rc.id = c.reply_id) AS "replyTo"`;
}

function buildGetCommentListSql({ sort, cursorCondition = '', direction = 'DESC' }) {
  const author = authorSelectExpr();

  if (sort === 'hot') {
    return `
      SELECT hot_comments.*
      FROM (
        SELECT
            c.id,
            c.content,
            c.status,
            c.create_at AS "createAt",
            ${author},
            (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
            (SELECT COUNT(*) FROM comment r WHERE r.comment_id = c.id) AS "replyCount"
        FROM comment c
        LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE c.article_id = ?
          AND c.comment_id IS NULL
      ) hot_comments
      WHERE 1 = 1
        ${cursorCondition}
      ORDER BY hot_comments.likes DESC, hot_comments."replyCount" DESC, hot_comments."createAt" DESC, hot_comments.id DESC
      LIMIT ?
    `;
  }

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.create_at AS "createAt",
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        (SELECT COUNT(*) FROM comment r WHERE r.comment_id = c.id) AS "replyCount"
    FROM comment c
    LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.article_id = ?
        AND c.comment_id IS NULL
        ${cursorCondition}
    ORDER BY c.create_at ${direction}, c.id ${direction}
    LIMIT ?
  `;
}

function buildGetUserCommentListSql() {
  const author = authorSelectExpr();
  const article = articleSelectExpr();

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.create_at AS "createAt",
        c.update_at AS "updateAt",
        c.article_id AS "articleId",
        a.title AS "articleTitle",
        ${author},
        ${article},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes
    FROM comment c
    LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    LEFT JOIN article a ON a.id = c.article_id
    WHERE c.user_id = ?
    ORDER BY c.create_at DESC
    LIMIT ? OFFSET ?
  `;
}

function buildUserCommentListExecuteParams(userId, offset, limit) {
  return [userId, limit, offset];
}

function buildGetReplyPreviewSql() {
  const author = authorSelectExpr();
  const replyTo = replyToSelectExpr();

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.comment_id cid,
        c.reply_id rid,
        c.create_at AS "createAt",
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        ${replyTo}
    FROM comment c
    LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.comment_id = ?
    ORDER BY c.create_at ASC
    LIMIT ?
  `;
}

function buildGetRepliesSql({ cursorCondition = '' }) {
  const author = authorSelectExpr();
  const replyTo = replyToSelectExpr();

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.comment_id cid,
        c.reply_id rid,
        c.create_at AS "createAt",
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        ${replyTo}
    FROM comment c
    LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.comment_id = ?
        ${cursorCondition}
    ORDER BY c.create_at ASC, c.id ASC
    LIMIT ?
  `;
}

function buildGetCommentByIdSql() {
  const author = authorSelectExpr();
  const replyTo = replyToSelectExpr();

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.comment_id cid,
        c.reply_id rid,
        c.article_id AS "articleId",
        c.create_at AS "createAt",
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        ${replyTo}
    FROM comment c
    LEFT JOIN ${USER_TABLE} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.id = ?
  `;
}

function buildAddCommentSql() {
  return 'INSERT INTO comment (user_id, article_id, content) VALUES (?, ?, ?) RETURNING id;';
}

function buildAddReplySql(hasReplyId) {
  if (hasReplyId) {
    return 'INSERT INTO comment (user_id, article_id, comment_id, reply_id, content) VALUES (?, ?, ?, ?, ?) RETURNING id;';
  }
  return 'INSERT INTO comment (user_id, article_id, comment_id, content) VALUES (?, ?, ?, ?) RETURNING id;';
}

module.exports = {
  buildAddCommentSql,
  buildAddReplySql,
  buildGetCommentListSql,
  buildGetCommentByIdSql,
  buildGetRepliesSql,
  buildGetReplyPreviewSql,
  buildGetUserCommentListSql,
  buildUserCommentListExecuteParams,
};
