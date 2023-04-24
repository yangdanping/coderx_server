const { connection } = require('../app');

class UserService {
  async getUserByName(name) {
    try {
      const statement = 'SELECT * FROM user WHERE name = ?;';
      const [result] = await connection.execute(statement, [name]); //拿到的元数据是数组,解构取得查询数据库结果,也是个数组
      return result[0]; //result就是我们真实查询结果,由于查询单个取第一个结果即可
    } catch (error) {
      console.log(error);
    }
  }
  async addUser(user) {
    try {
      const { name, password } = user;
      const statement = 'INSERT INTO user (name,password) VALUES (?,?);';
      const [result] = await connection.execute(statement, [name, password]);
      if (result.affectedRows) {
        try {
          const statement = 'INSERT INTO profile (user_id) VALUES (?);';
          await connection.execute(statement, [result.insertId]);
          return result; //把插入用户表成功的结果返回,而非用户信息表
        } catch (error) {
          console.log(error);
        }
      }
    } catch (error) {
      console.log(error);
    }
  }
  async updateAvatarUrl(avatarUrl, userId) {
    try {
      const statement = `UPDATE profile SET avatar_url = ? WHERE user_id = ?;`;
      const [result] = await connection.execute(statement, [avatarUrl, userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getProfileById(userId) {
    try {
      const statement = `
      SELECT u.id id,u.name name,p.avatar_url avatarUrl,p.age age,p.sex sex,p.email email,
      p.career career,p.address address,
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
  }
  async updateProfileById(userId, profile) {
    try {
      let updateValue = [];
      Object.keys(profile).forEach((key) => updateValue.push(profile[key]));
      const updateItem = Object.keys(profile).join(' = ?,').concat(' = ?');
      const statement = `UPDATE profile SET ${updateItem} WHERE user_id = ?;`;
      console.log(statement);
      console.log([...updateValue, userId]);
      const [result] = await connection.execute(statement, [...updateValue, userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async hasLike(tableName, dataId, userId) {
    try {
      const statement = `SELECT * FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return result[0] ? true : false;
    } catch (error) {
      console.log(error);
    }
  }
  async changeLike(tableName, dataId, userId, isLike) {
    try {
      const statement = !isLike
        ? `INSERT INTO ${tableName}_like (${tableName}_id,user_id) VALUES (?,?);`
        : `DELETE FROM ${tableName}_like WHERE ${tableName}_id = ? AND user_id = ?;`;
      const [result] = await connection.execute(statement, [dataId, userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getLikedById(userId) {
    try {
      const statement = `
      SELECT u.id id,u.name name,JSON_ARRAYAGG(al.article_id) articleLiked,
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
  }
  async hasFollowed(userId, followerId) {
    try {
      const statement = `SELECT * FROM user_follow WHERE user_id = ? AND follower_id= ?;`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result[0] ? true : false;
    } catch (error) {
      console.log(error);
    }
  }
  async follow(userId, followerId) {
    try {
      const statement = `INSERT INTO user_follow (user_id,follower_id) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async unfollow(userId, followerId) {
    try {
      const statement = `DELETE FROM user_follow WHERE user_id = ? AND follower_id = ?;`;
      const [result] = await connection.execute(statement, [userId, followerId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getFollowInfo(userId) {
    try {
      const statement = `
      SELECT u.id id,u.name name,
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
  }
  async getArticleById(userId, offset, limit) {
    try {
      const statement = `
      SELECT a.id id,a.title title,a.content content,a.create_at createAt
      FROM article a
      WHERE a.user_id = ?
      LIMIT ?,?;
      `;
      const [result] = await connection.execute(statement, [userId, offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getArticleByCollectId(userId, collectId, offset, limit) {
    try {
      const statement = `
      SELECT a.id id,a.title title,a.content content,a.create_at createAt
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
  }
  async getCommentById(userId, offset, limit) {
    try {
      const statement = `
      SELECT a.id id,a.title title,c.content content,c.create_at createAt
      FROM comment c
      LEFT JOIN article a
      ON c.article_id = a.id
      WHERE c.user_id = ?
      LIMIT ?,?;
      `;
      const [result] = await connection.execute(statement, [userId, offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async userReport(userId, reportOptions, articleId, commentId) {
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
  }
  async userFeedback(userId, content) {
    try {
      const statement = `INSERT INTO feedback (user_id,content) VALUES (?,?);`;
      const [result] = await connection.execute(statement, [userId, content]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async getReplyByUserId(userId) {
    try {
      const statement = `
      SELECT f.id id,u.name name,f.content content,a.name admin,f.reply reply,f.create_at createAt
      FROM feedback f
      LEFT JOIN user u ON u.id = f.user_id
      LEFT JOIN admin a ON a.id = f.admin_id
      WHERE f.user_id = ? AND f.reply IS NOT NULL
      ORDER BY f.create_at;`;
      const [result] = await connection.execute(statement, [userId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new UserService();
