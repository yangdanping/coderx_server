const connection = require('@/app/database');

class TagService {
  addTag = async (name) => {
    const statement = `INSERT INTO tag (name) VALUES (?);`;
    const [result] = await connection.execute(statement, [name]);
    return result;
  };

  getTagByName = async (name) => {
    const statement = `SELECT * FROM tag WHERE name = ?;`;
    const [result] = await connection.execute(statement, [name]);
    return result[0];
  };

  getTagList = async (offset, limit) => {
    console.log('getTagList offset, limit', offset, limit);
    const statement = `SELECT * FROM tag LIMIT ?,?;`;
    const [result] = await connection.execute(statement, [offset, limit]);
    return result;
  };
}

module.exports = new TagService();
