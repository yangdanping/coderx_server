const { connection } = require('../app');

class TagService {
  async addTag(name) {
    try {
      const statement = `INSERT INTO tag (name) VALUES (?);`;
      const [result] = await connection.execute(statement, [name]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }

  async getTagByName(name) {
    try {
      const statement = `SELECT * FROM tag WHERE name = ?;`;
      const [result] = await connection.execute(statement, [name]);
      return result[0]; //直接把查到的记录返回,不存在时返回的是undefined
    } catch (error) {
      console.log(error);
    }
  }

  async getTagList(offset, limit) {
    try {
      const statement = `SELECT * FROM tag LIMIT ?,?;`;
      const [result] = await connection.execute(statement, [offset, limit]);
      return result;
    } catch (error) {
      console.log(error);
    }
  }
}

module.exports = new TagService();
