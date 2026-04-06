const connection = require('@/app/database');
const { buildAddTagSql, buildGetTagListExecuteParams, buildGetTagListSql } = require('./tag.sql');

class TagService {
  addTag = async (name) => {
    const statement = buildAddTagSql(connection.dialect);
    const [result] = await connection.execute(statement, [name]);
    return result;
  };

  getTagByName = async (name) => {
    const statement = `SELECT * FROM tag WHERE name = ?;`;
    const [result] = await connection.execute(statement, [name]);
    return result[0];
  };

  getTagList = async (offset, limit) => {
    const statement = buildGetTagListSql(connection.dialect);
    const executeParams = buildGetTagListExecuteParams(connection.dialect, offset, limit);
    const [result] = await connection.execute(statement, executeParams);
    return result;
  };
}

module.exports = new TagService();
