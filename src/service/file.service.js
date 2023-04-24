const { connection } = require('../app');

class FileService {
  async addAvatar(userId, filename, mimetype, size) {
    try {
      const statement = `INSERT INTO avatar (user_id,filename, mimetype, size) VALUES (?,?,?,?)`;
      const [result] = await connection.execute(statement, [userId, filename, mimetype, size]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }

  async getAvatarById(userId) {
    try {
      const statement = `SELECT * FROM avatar WHERE user_id = ?;`;
      const [result] = await connection.execute(statement, [userId]);
      return result.pop(); //.pop(),取到的永远是数组中的最后一个,也就是该id用户的上传的最后一个头像
    } catch (error) {
      console.log(error);
    }
  }
  async addFile(userId, filename, mimetype, size) {
    try {
      const statement = `INSERT INTO file (user_id,filename, mimetype, size) VALUES (?,?,?,?);`;
      const [result] = await connection.execute(statement, [userId, filename, mimetype, size]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  // async addFile(userId, articleId, filename, mimetype, size) {
  //   try {
  //     const statement = `INSERT INTO file (user_id, article_id, filename, mimetype, size) VALUES (?,?,?,?,?);`;
  //     const [result] = await connection.execute(statement, [userId, articleId, filename, mimetype, size]);
  //     return result;
  //   } catch (error) {
  //     console.log(error);
  //   }
  // }

  async getFileByFilename(filename) {
    try {
      const statement = `SELECT * FROM file WHERE filename = ?;`;
      const [result] = await connection.execute(statement, [filename]);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  }
  async updateFile(articleId, uploaded) {
    try {
      const statement = `UPDATE file SET article_id = ? WHERE id IN (${uploaded.join(',')})`;
      console.log(statement);
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new FileService();
