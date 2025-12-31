const connection = require('@/app/database');

class UserService {
  getUserByName = async (name) => {
    try {
      const statement = 'SELECT * FROM user WHERE name = ?;';
      const [result] = await connection.execute(statement, [name]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result[0]; //result就是我们真实查询结果,由于查询单个取第一个结果即可
    } catch (error) {
      console.log(error);
    }
  };
  addUser = async (user) => {
    // 获取独立连接以支持事务
    const conn = await connection.getConnection();
    try {
      // 开始事务
      await conn.beginTransaction();

      const { name, password } = user;

      // 第一步：插入用户表
      const statement1 = 'INSERT INTO user (name, password) VALUES (?, ?);';
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
  updateAvatarUrl = async (avatarUrl, userId) => {
    try {
      const statement = `UPDATE profile SET avatar_url = ? WHERE user_id = ?;`;
      const [result] = await connection.execute(statement, [avatarUrl, userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
  getProfileById = async (userId) => {
    try {
      const statement = `
      SELECT u.id,u.name,u.status,p.avatar_url avatarUrl,p.age,p.sex,p.email,
      p.career,p.address,
      (SELECT COUNT(*)
      FROM article a
      WHERE a.user_id = u.id) articleCount,
      (SELECT COUNT(*)
      FROM comment c
      WHERE c.user_id = u.id) commentCount
      FROM user u
      LEFT JOIN profile p
      ON u.id = p.user_id
      WHERE u.id = ?;`;
      const [result] = await connection.execute(statement, [userId]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  };
  /**
   * 重构说明：
   * 1. 采用更安全的方式处理动态列更新。
   * 2. 虽然列名通常由后端控制，但使用参数化查询处理所有值。
   */
  updateProfileById = async (userId, profile) => {
    try {
      const keys = Object.keys(profile);
      if (keys.length === 0) return null;

      const updateItem = keys.map((key) => `${key} = ?`).join(', ');
      const updateValues = Object.values(profile);
      const statement = `UPDATE profile SET ${updateItem} WHERE user_id = ?;`;

      const [result] = await connection.execute(statement, [...updateValues, userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
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

  /**
   * 重构说明：
   * 1. 修复 LIKE 子句中的 SQL 注入风险，改用 ? 占位符。
   * 2. 移除 SQL 语句中多余的分号。
   */
  getCommentById = async (userId, offset, limit) => {
    try {
      const statement = `
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
      const [result] = await connection.execute(statement, [userId, offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };

  /**
   * 重构说明：
   * 1. 增加表名白名单校验。
   */
  hasLike = async (tableName, dataId, userId) => {
    const whiteList = ['article', 'comment', 'video'];
    if (!whiteList.includes(tableName)) return false;

    try {
      const statement = `SELECT * FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return result[0] ? true : false;
    } catch (error) {
      console.log(error);
    }
  };

  /**
   * 重构说明：
   * 1. 增加表名白名单校验。
   */
  changeLike = async (tableName, dataId, userId, isLike) => {
    const whiteList = ['article', 'comment', 'video'];
    if (!whiteList.includes(tableName)) return null;

    try {
      const statement = !isLike
        ? `INSERT INTO ${tableName}_like (${tableName}_id,user_id) VALUES (?,?);`
        : `DELETE FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };

  getLikedById = async (userId) => {
    try {
      const statement = `
      SELECT u.id,u.name,JSON_ARRAYAGG(al.article_id) articleLiked,
      (SELECT JSON_ARRAYAGG(cl.comment_id) FROM user
      LEFT JOIN comment_like cl
      ON user.id = cl.user_id
      WHERE user.id = u.id
      GROUP BY user.id) commentLiked
      FROM user u
      LEFT JOIN article_like al
      ON u.id = al.user_id
      WHERE u.id = ?
      GROUP BY u.id;`;
      const [result] = await connection.execute(statement, [userId]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  };

  hasFollowed = async (userId, followerId) => {
    try {
      const statement = `SELECT * FROM user_follow WHERE user_id = ? AND follower_id= ?;`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result[0] ? true : false;
    } catch (error) {
      console.log(error);
    }
  };

  follow = async (userId, followerId) => {
    try {
      const statement = `INSERT INTO user_follow (user_id,follower_id) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };

  unfollow = async (userId, followerId) => {
    try {
      const statement = `DELETE FROM user_follow WHERE user_id = ? AND follower_id = ?;`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  };

  getFollowInfo = async (userId) => {
    try {
      const statement = `
      SELECT u.id,u.name,
      IF(COUNT(uf.follower_id),JSON_ARRAYAGG(JSON_OBJECT('id',uf.user_id,'name',
      (SELECT user.name from user WHERE user.id = uf.user_id),
      'avatarUrl',p.avatar_url,'sex',p.sex,'career',p.career
      )),NULL) following,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id',ufo.follower_id,
      'name',us.name,'avatarUrl',pf.avatar_url,'sex',pf.sex,'career',pf.career)) FROM user us
      LEFT JOIN user_follow ufo ON us.id = ufo.follower_id LEFT JOIN profile pf ON us.id = pf.user_id
      WHERE ufo.user_id = u.id GROUP BY ufo.user_id) follower
      FROM user u LEFT JOIN user_follow uf ON u.id = uf.follower_id LEFT JOIN profile p ON uf.user_id = p.user_id
      WHERE u.id = ?
      GROUP BY u.id;`;
      const [result] = await connection.execute(statement, [userId]);
      return result[0]; //只拿到一条记录
    } catch (error) {
      console.log(error);
    }
  };

  getArticleByCollectId = async (userId, collectId, offset, limit) => {
    try {
      const statement = `
      SELECT a.id,a.title,a.content,a.create_at createAt
      FROM article_collect ac
      LEFT JOIN collect c ON ac.collect_id = c.id
      LEFT JOIN article a ON ac.article_id = a.id
      WHERE c.user_id = ? AND c.id = ?
      LIMIT ?,?;
      `;
      const [result] = await connection.execute(statement, [userId, collectId, offset, limit]);
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
      const statement = `
      SELECT u.id,u.name,p.avatar_url avatarUrl,p.age,p.sex,p.email,
      p.career,p.address,
      (SELECT JSON_OBJECT('totalLikes',COUNT(al.article_id),'totalViews',SUM(a.views))
      FROM article a
      LEFT JOIN article_like al ON a.id = al.article_id
      WHERE a.user_id = u.id) articleInfo
      FROM user u
      LEFT JOIN profile p
      ON u.id = p.user_id
      ORDER BY u.id
      LIMIT 0,5;`;
      const [result] = await connection.execute(statement);
      return result;
    } catch (error) {
      console.log(error);
    }
  };
}

module.exports = new UserService();
