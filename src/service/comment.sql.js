function userTableExpr(dialect) {
  return dialect === 'pg' ? '"user"' : 'user';
}

function authorSelectExpr(dialect, alias = 'u', profileAlias = 'p') {
  if (dialect === 'pg') {
    return `jsonb_build_object('id', ${alias}.id, 'name', ${alias}.name, 'avatarUrl', ${profileAlias}.avatar_url) author`;
  }
  return `JSON_OBJECT('id', ${alias}.id, 'name', ${alias}.name, 'avatarUrl', ${profileAlias}.avatar_url) author`;
}

function articleSelectExpr(dialect, alias = 'a') {
  if (dialect === 'pg') {
    return `jsonb_build_object('id', ${alias}.id, 'title', ${alias}.title) article`;
  }
  return `JSON_OBJECT('id', ${alias}.id, 'title', ${alias}.title) article`;
}

function replyToSelectExpr(dialect) {
  const userTable = userTableExpr(dialect);
  if (dialect === 'pg') {
    return `(SELECT jsonb_build_object('id', ru.id, 'name', ru.name, 'content', rc.content)
        FROM comment rc
        LEFT JOIN ${userTable} ru ON ru.id = rc.user_id
        WHERE rc.id = c.reply_id) AS "replyTo"`;
  }
  return `(SELECT JSON_OBJECT('id', ru.id, 'name', ru.name, 'content', rc.content)
      FROM comment rc
      LEFT JOIN ${userTable} ru ON ru.id = rc.user_id
      WHERE rc.id = c.reply_id) replyTo`;
}

function paginationClause(dialect) {
  return dialect === 'pg' ? 'LIMIT ? OFFSET ?' : 'LIMIT ?, ?';
}

function buildGetCommentListSql(dialect, { sort, cursorCondition = '', direction = 'DESC' }) {
  const author = authorSelectExpr(dialect);
  const userTable = userTableExpr(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);

  if (sort === 'hot') {
    return `
      SELECT hot_comments.*
      FROM (
        SELECT
            c.id,
            c.content,
            c.status,
            c.create_at AS ${q('createAt')},
            ${author},
            (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
            (SELECT COUNT(*) FROM comment r WHERE r.comment_id = c.id) AS ${q('replyCount')}
        FROM comment c
        LEFT JOIN ${userTable} u ON u.id = c.user_id
        LEFT JOIN profile p ON u.id = p.user_id
        WHERE c.article_id = ?
          AND c.comment_id IS NULL
      ) hot_comments
      WHERE 1 = 1
        ${cursorCondition}
      ORDER BY hot_comments.likes DESC, hot_comments.${q('replyCount')} DESC, hot_comments.${q('createAt')} DESC, hot_comments.id DESC
      LIMIT ?
    `;
  }

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.create_at AS ${q('createAt')},
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        (SELECT COUNT(*) FROM comment r WHERE r.comment_id = c.id) AS ${q('replyCount')}
    FROM comment c
    LEFT JOIN ${userTable} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.article_id = ?
        AND c.comment_id IS NULL
        ${cursorCondition}
    ORDER BY c.create_at ${direction}, c.id ${direction}
    LIMIT ?
  `;
}

function buildGetUserCommentListSql(dialect) {
  const author = authorSelectExpr(dialect);
  const article = articleSelectExpr(dialect);
  const userTable = userTableExpr(dialect);
  const limitClause = paginationClause(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.create_at AS ${q('createAt')},
        c.update_at AS ${q('updateAt')},
        c.article_id AS ${q('articleId')},
        a.title AS ${q('articleTitle')},
        ${author},
        ${article},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes
    FROM comment c
    LEFT JOIN ${userTable} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    LEFT JOIN article a ON a.id = c.article_id
    WHERE c.user_id = ?
    ORDER BY c.create_at DESC
    ${limitClause}
  `;
}

function buildUserCommentListExecuteParams(dialect, userId, offset, limit) {
  if (dialect === 'pg') {
    return [userId, limit, offset];
  }
  return [userId, offset, limit];
}

function buildGetReplyPreviewSql(dialect) {
  const author = authorSelectExpr(dialect);
  const userTable = userTableExpr(dialect);
  const replyTo = replyToSelectExpr(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.comment_id cid,
        c.reply_id rid,
        c.create_at AS ${q('createAt')},
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        ${replyTo}
    FROM comment c
    LEFT JOIN ${userTable} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.comment_id = ?
    ORDER BY c.create_at ASC
    LIMIT ?
  `;
}

function buildGetRepliesSql(dialect, { cursorCondition = '' }) {
  const author = authorSelectExpr(dialect);
  const userTable = userTableExpr(dialect);
  const replyTo = replyToSelectExpr(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.comment_id cid,
        c.reply_id rid,
        c.create_at AS ${q('createAt')},
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        ${replyTo}
    FROM comment c
    LEFT JOIN ${userTable} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.comment_id = ?
        ${cursorCondition}
    ORDER BY c.create_at ASC, c.id ASC
    LIMIT ?
  `;
}

function buildGetCommentByIdSql(dialect) {
  const author = authorSelectExpr(dialect);
  const userTable = userTableExpr(dialect);
  const replyTo = replyToSelectExpr(dialect);
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);

  return `
    SELECT
        c.id,
        c.content,
        c.status,
        c.comment_id cid,
        c.reply_id rid,
        c.article_id AS ${q('articleId')},
        c.create_at AS ${q('createAt')},
        ${author},
        (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c.id) likes,
        ${replyTo}
    FROM comment c
    LEFT JOIN ${userTable} u ON u.id = c.user_id
    LEFT JOIN profile p ON u.id = p.user_id
    WHERE c.id = ?
  `;
}

function buildAddCommentSql(dialect) {
  const returning = dialect === 'pg' ? ' RETURNING id;' : '';
  return `INSERT INTO comment (user_id, article_id, content) VALUES (?, ?, ?)${returning}`;
}

function buildAddReplySql(dialect, hasReplyId) {
  const returning = dialect === 'pg' ? ' RETURNING id;' : '';
  if (hasReplyId) {
    return `INSERT INTO comment (user_id, article_id, comment_id, reply_id, content) VALUES (?, ?, ?, ?, ?)${returning}`;
  }
  return `INSERT INTO comment (user_id, article_id, comment_id, content) VALUES (?, ?, ?, ?)${returning}`;
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
