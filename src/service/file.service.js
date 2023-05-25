const { connection } = require('../app');
const { COVER_SUFFIX } = require('../constants/file');

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
      const statement = `SELECT * FROM file WHERE filename LIKE '${filename}%';`; //只看前缀
      const [result] = await connection.execute(statement);
      return result[0];
    } catch (error) {
      console.log(error);
    }
  }
  async updateFile(articleId, uploaded) {
    try {
      // const statement = `UPDATE file SET article_id = ? WHERE id IN (${uploaded.join(',')})`;
      const statement = `
      UPDATE file SET article_id = ?,
      filename = CASE id
      WHEN ${uploaded[0]} THEN CONCAT(filename,'${COVER_SUFFIX}')
      ELSE filename
      END
      WHERE id IN (${uploaded.join(',')});
      `;

      console.log(statement);
      const [result] = await connection.execute(statement, [articleId]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async findFileById(uploaded) {
    try {
      const statement = `SELECT f.filename FROM file f WHERE f.id IN (${uploaded.join(',')});`;
      const [result] = await connection.execute(statement);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
  async delete(uploaded) {
    try {
      const statement = `DELETE FROM file f WHERE f.id IN (${uploaded.join(',')});`;
      const [result] = await connection.execute(statement);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new FileService();
