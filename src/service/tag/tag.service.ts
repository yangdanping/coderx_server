import BusinessError from '../../errors/BusinessError.js';
import {
  buildAddTagSql,
  buildDeleteUserTagOrderSql,
  buildGetExistingTagIdsSql,
  buildGetTagByNameSql,
  buildGetTagListExecuteParams,
  buildGetTagListSql,
  buildGetUserTagOrderSql,
  buildInsertUserTagOrderSql,
  type TagPagination,
} from './tag.sql.js';

interface Tag {
  id: number;
  name: string;
}

interface TagInsertResult {
  affectedRows: number;
  changedRows: number;
  insertId: number;
  rowCount: number;
  command: string;
}

interface TagQueryExecutor {
  execute(sql: string, params: unknown[]): Promise<readonly [result: unknown, fields: unknown]>;
}

interface TagTransaction extends TagQueryExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface TagDatabase extends TagQueryExecutor {
  getConnection(): Promise<TagTransaction>;
}

function validateTagIds(tagIds: unknown): asserts tagIds is number[] {
  if (!Array.isArray(tagIds)) {
    throw new BusinessError('标签顺序必须是数组', 400);
  }
  if (tagIds.some((tagId: unknown) => typeof tagId !== 'number' || !Number.isSafeInteger(tagId) || tagId <= 0)) {
    throw new BusinessError('标签 ID 必须是正整数', 400);
  }
  if (new Set(tagIds).size !== tagIds.length) {
    throw new BusinessError('标签顺序不能包含重复项', 400);
  }
}

export function createTagService(database: TagDatabase) {
  return {
    async addTag(name: unknown): Promise<TagInsertResult> {
      const [result] = await database.execute(buildAddTagSql(), [name]);
      return result as TagInsertResult;
    },

    async getTagByName(name: unknown): Promise<Tag | undefined> {
      const [rows] = await database.execute(buildGetTagByNameSql(), [name]);
      return (rows as Tag[])[0];
    },

    async getTagList(offset: TagPagination, limit: TagPagination): Promise<Tag[]> {
      const [rows] = await database.execute(buildGetTagListSql(), buildGetTagListExecuteParams(offset, limit));
      return rows as Tag[];
    },

    async getUserTagOrder(userId: unknown): Promise<Tag[]> {
      const [rows] = await database.execute(buildGetUserTagOrderSql(), [userId]);
      return rows as Tag[];
    },

    async replaceUserTagOrder(userId: unknown, tagIds: unknown): Promise<Tag[]> {
      validateTagIds(tagIds);
      const transaction = await database.getConnection();

      try {
        await transaction.beginTransaction();

        const existingTagIdsSql = buildGetExistingTagIdsSql(tagIds.length);
        if (existingTagIdsSql) {
          const [result] = await transaction.execute(existingTagIdsSql, tagIds);
          const existingTags = result as Array<Pick<Tag, 'id'>>;
          if (existingTags.length !== tagIds.length) {
            throw new BusinessError('标签不存在', 400);
          }
        }

        await transaction.execute(buildDeleteUserTagOrderSql(), [userId]);

        const insertOrderSql = buildInsertUserTagOrderSql(tagIds.length);
        if (insertOrderSql) {
          const insertParams = tagIds.flatMap((tagId, sortOrder) => [userId, tagId, sortOrder]);
          await transaction.execute(insertOrderSql, insertParams);
        }

        const [orderedTags] = await transaction.execute(buildGetUserTagOrderSql(), [userId]);
        await transaction.commit();
        return orderedTags as Tag[];
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        transaction.release();
      }
    },
  };
}

export type TagService = ReturnType<typeof createTagService>;
