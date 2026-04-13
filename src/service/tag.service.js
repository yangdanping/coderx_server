const connection = require('@/app/database');
const { buildAddTagSql, buildGetTagListExecuteParams, buildGetTagListSql } = require('./sql/tag.sql');

class TagService {
  addTag = async (name) => {
    const statement = buildAddTagSql();
    const [result] = await connection.execute(statement, [name]);
    return result;
  };

  getTagByName = async (name) => {
    const statement = `SELECT * FROM tag WHERE name = ?;`;
    const [result] = await connection.execute(statement, [name]);
    return result[0];
  };

  getTagList = async (offset, limit) => {
    const statement = buildGetTagListSql();
    const executeParams = buildGetTagListExecuteParams(offset, limit);
    const [result] = await connection.execute(statement, executeParams);
    return result;
  };
}

module.exports = new TagService();
