const connection = require('@/app/database');
const BusinessError = require('@/errors/BusinessError');
const {
  buildGetArticleByCollectIdExecuteParams,
  buildGetArticleByCollectIdSql,
  buildGetCommentByIdExecuteParams,
  buildGetCommentByIdSql,
  buildGetFollowInfoSql,
  buildGetHotUsersSql,
  buildGetLikedByIdSql,
  buildGetProfileByIdSql,
  buildGetUserByNameSql,
} = require('./sql/user.sql');

class UserService {
  getUserByName = async (name) => {
    const statement = buildGetUserByNameSql();
    const [result] = await connection.execute(statement, [name]);
    return result[0];
  };
  addUser = async (user) => {
    // 获取独立连接以支持事务
    const conn = await connection.getConnection();
    try {
      // 开始事务
      await conn.beginTransaction();

      const { name, password } = user;

      // 第一步：插入用户表
      const statement1 = 'INSERT INTO "user" (name, password) VALUES (?, ?) RETURNING id;';
      const [result] = await conn.execute(statement1, [name, password]);

      // 第二步：插入用户信息表，关联新用户ID
      const statement2 = 'INSERT INTO profile (user_id) VALUES (?);';
      await conn.execute(statement2, [result.insertId]);

      // 提交事务：两条SQL一起生效
      await conn.commit();

      return result; // 返回用户表插入结果
    } catch (error) {
      // 回滚事务：撤销所有操作
      await conn.rollback();
      console.error('添加用户失败:', error);
      throw error; // 抛出错误让上层处理
    } finally {
      // 释放连接回连接池
      conn.release();
    }

    // try {
    //   const { name, password } = user;
    //   const statement = 'INSERT INTO user (name,password) VALUES (?,?);';
    //   const [result] = await connection.execute(statement, [name, password]);
    //   if (result.affectedRows) {
    //     try {
    //       const statement = 'INSERT INTO profile (user_id) VALUES (?);';
    //       await connection.execute(statement, [result.insertId]);
    //       return result; //把插入用户表成功的结果返回,而非用户信息表
    //     } catch (error) {
    //       console.log(error);
    //     }
    //   }
    // } catch (error) {
    //   console.log(error);
    // }
  };
  updateAvatarUrl = async (avatarUrl, userId, conn = null) => {
    const statement = `UPDATE profile SET avatar_url = ? WHERE user_id = ?;`;
    const execute = conn ? conn.execute.bind(conn) : connection.execute.bind(connection);
    const [result] = await execute(statement, [avatarUrl, userId]);
    return result;
  };
  getProfileById = async (userId) => {
    const statement = buildGetProfileByIdSql();
    const [result] = await connection.execute(statement, [userId]);
    return result[0];
  };
  updateProfileById = async (userId, profile) => {
    const keys = Object.keys(profile);
    if (keys.length === 0) return null;

    const updateItem = keys.map((key) => `${key} = ?`).join(', ');
    const updateValues = Object.values(profile);
    const statement = `UPDATE profile SET ${updateItem} WHERE user_id = ?;`;

    const [result] = await connection.execute(statement, [...updateValues, userId]);
    return result;
  };

  // getCommentById = async (userId, offset, limit) => {
  //   try {
  //     const statement = `
  //     SELECT c.id, a.title,c.content, c.comment_id commentId, c.create_at createAt,
  //     JSON_OBJECT('id', u.id, 'name', u.name,'avatarUrl',p.avatar_url) user,
  //     COUNT(cl.user_id) likes
  //     FROM comment c
  //     LEFT JOIN article a ON c.article_id = a.id
  //     LEFT JOIN user u ON u.id = c.user_id
  //     LEFT JOIN profile p ON u.id = p.user_id
  //     LEFT JOIN comment_like cl ON c.id = cl.comment_id
  //     WHERE u.id LIKE '%${userId}%'
  //     GROUP BY c.id
  //     ORDER BY c.update_at DESC;
  //     LIMIT ?,?;
  //     `;
  //     // const statement = `
  //     // SELECT a.id id,a.title title,c.content content,c.create_at createAt
  //     // FROM comment c
  //     // LEFT JOIN article a
  //     // ON c.article_id = a.id
  //     // WHERE c.user_id = ?
  //     // LIMIT ?,?;
  //     // `;
  //     const [result] = await connection.execute(statement, [userId, offset, limit]);
  //     return result;
  //   } catch (error) {
  //     console.log(error);
  //   }
  // };

  getCommentById = async (userId, offset, limit) => {
    const statement = buildGetCommentByIdSql();
    const executeParams = buildGetCommentByIdExecuteParams(userId, String(offset), String(limit));
    const [result] = await connection.execute(statement, executeParams);
    return result;
  };

  hasLike = async (tableName, dataId, userId) => {
    const whiteList = ['article', 'comment', 'video'];
    if (!whiteList.includes(tableName)) return false;

    const statement = `SELECT * FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
    const [result] = await connection.execute(statement, [dataId, userId]);
    return result[0] ? true : false;
  };

  changeLike = async (tableName, dataId, userId, isLike) => {
    const whiteList = ['article', 'comment', 'video'];
    if (!whiteList.includes(tableName)) return null;

    const statement = !isLike
      ? `INSERT INTO ${tableName}_like (${tableName}_id,user_id) VALUES (?,?);`
      : `DELETE FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
    const [result] = await connection.execute(statement, [dataId, userId]);
    return result;
  };

  // 优化：点赞/取消点赞切换，减少数据库查询
  toggleLike = async (tableName, dataId, userId) => {
    const whiteList = ['article', 'comment', 'video'];
    if (!whiteList.includes(tableName)) {
      throw new BusinessError('非法的表名', 400);
    }

    // 先尝试删除
    const deleteStmt = `DELETE FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
    const [deleteResult] = await connection.execute(deleteStmt, [dataId, userId]);

    // 如果删除了行，说明之前已点赞，现在取消
    if (deleteResult.affectedRows > 0) {
      return { isLiked: false, action: 'unliked' };
    }

    // 如果没删除任何行，说明之前未点赞，现在添加
    const insertStmt = `INSERT INTO ${tableName}_like (${tableName}_id, user_id) VALUES (?, ?);`;
    await connection.execute(insertStmt, [dataId, userId]);
    return { isLiked: true, action: 'liked' };
  };

  getLikedById = async (userId) => {
    try {
      const statement = buildGetLikedByIdSql();
      const [result] = await connection.execute(statement, [userId]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  };

  hasFollowed = async (userId, followerId) => {
    const statement = `SELECT * FROM user_follow WHERE user_id = ? AND follower_id= ?;`;
    const [result] = await connection.execute(statement, [userId, followerId]);
    return result[0] ? true : false;
  };

  follow = async (userId, followerId) => {
    const statement = `INSERT INTO user_follow (user_id,follower_id) VALUES (?,?);`;
    const [result] = await connection.execute(statement, [userId, followerId]);
    return result;
  };

  unfollow = async (userId, followerId) => {
    const statement = `DELETE FROM user_follow WHERE user_id = ? AND follower_id = ?;`;
    const [result] = await connection.execute(statement, [userId, followerId]);
    return result;
  };

  // 优化：关注/取关切换，减少数据库查询
  toggleFollow = async (userId, followerId) => {
    // 先尝试删除
    const deleteStmt = `DELETE FROM user_follow WHERE user_id = ? AND follower_id = ?;`;
    const [deleteResult] = await connection.execute(deleteStmt, [userId, followerId]);

    // 如果删除了行，说明之前已关注，现在取关
    if (deleteResult.affectedRows > 0) {
      return { isFollowed: false, action: 'unfollowed' };
    }

    // 如果没删除任何行，说明之前未关注，现在添加
    const insertStmt = `INSERT INTO user_follow (user_id, follower_id) VALUES (?, ?);`;
    await connection.execute(insertStmt, [userId, followerId]);
    return { isFollowed: true, action: 'followed' };
  };

  getFollowInfo = async (userId) => {
    try {
      const statement = buildGetFollowInfoSql();
      const [result] = await connection.execute(statement, [userId]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  };

  getArticleByCollectId = async (userId, collectId, offset, limit) => {
    try {
      const statement = buildGetArticleByCollectIdSql();
      const executeParams = buildGetArticleByCollectIdExecuteParams(userId, collectId, String(offset), String(limit));
      const [result] = await connection.execute(statement, executeParams);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  userReport = async (userId, reportOptions, articleId, commentId) => {
    try {
      const statement = `INSERT INTO report (user_id,content,${articleId ? 'article_id' : 'comment_id'}) VALUES (?,?,?);`;
      console.log(statement);
      let arr = [userId, reportOptions];
      articleId ? arr.push(articleId) : arr.push(commentId);
      const [result] = await connection.execute(statement, arr);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  // userFeedback = async (userId, content) => {
  //   try {
  //     const statement = `INSERT INTO feedback (user_id,content) VALUES (?,?);`;
  //     const [result] = await connection.execute(statement, [userId, content]);
  //     return result;
  //   } catch (error) {
  //     console.log(error);
  //   }
  // };
  // getReplyByUserId = async (userId) => {
  //   try {
  //     const statement = `
  //     SELECT f.id,u.name,f.content,a.name admin,f.reply,f.create_at createAt
  //     FROM feedback f
  //     LEFT JOIN user u ON u.id = f.user_id
  //     LEFT JOIN admin a ON a.id = f.admin_id
  //     WHERE f.user_id = ? AND f.reply IS NOT NULL
  //     ORDER BY f.create_at;`;
  //     const [result] = await connection.execute(statement, [userId]);
  //     return result;
  //   } catch (error) {
  //     console.log(error);
  //   }
  // };
  getHotUsers = async () => {
    try {
      const statement = buildGetHotUsersSql();
      const [result] = await connection.execute(statement);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
}

module.exports = new UserService();
