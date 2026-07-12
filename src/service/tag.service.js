const connection = require('@/app/database');
const BusinessError = require('@/errors/BusinessError');
const {
  buildAddTagSql,
  buildDeleteUserTagOrderSql,
  buildGetExistingTagIdsSql,
  buildGetTagListExecuteParams,
  buildGetTagListSql,
  buildGetUserTagOrderSql,
  buildInsertUserTagOrderSql,
} = require('./sql/tag.sql');

function validateTagIds(tagIds) {
  if (!Array.isArray(tagIds)) {
    throw new BusinessError('标签顺序必须是数组', 400);
  }
  if (tagIds.some((tagId) => !Number.isSafeInteger(tagId) || tagId <= 0)) {
    throw new BusinessError('标签 ID 必须是正整数', 400);
  }
  if (new Set(tagIds).size !== tagIds.length) {
    throw new BusinessError('标签顺序不能包含重复项', 400);
  }
}

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

  getUserTagOrder = async (userId) => {
    const [result] = await connection.execute(buildGetUserTagOrderSql(), [userId]);
    return result;
  };

  replaceUserTagOrder = async (userId, tagIds) => {
    validateTagIds(tagIds);
    const transaction = await connection.getConnection();

    try {
      await transaction.beginTransaction();

      if (tagIds.length > 0) {
        const [existingTags] = await transaction.execute(buildGetExistingTagIdsSql(tagIds.length), tagIds);
        if (existingTags.length !== tagIds.length) {
          throw new BusinessError('标签不存在', 400);
        }
      }

      await transaction.execute(buildDeleteUserTagOrderSql(), [userId]);

      if (tagIds.length > 0) {
        const insertParams = tagIds.flatMap((tagId, sortOrder) => [userId, tagId, sortOrder]);
        await transaction.execute(buildInsertUserTagOrderSql(tagIds.length), insertParams);
      }

      const [orderedTags] = await transaction.execute(buildGetUserTagOrderSql(), [userId]);
      await transaction.commit();
      return orderedTags;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.release();
    }
  };
}

module.exports = new TagService();
