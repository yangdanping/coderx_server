import type { QueryExecutor } from '../../app/database/database.types.js';
import { z } from 'zod';
import SqlUtils from '../../utils/SqlUtils.js';
import {
  buildAddCollectSql,
  buildGetCollectArticleSql,
  buildGetCollectListExecuteParams,
  buildGetCollectListSql,
} from '../sql/collect.sql.js';

type CollectDatabase = QueryExecutor;
const deleteMembership = 'DELETE FROM article_collect WHERE article_id = ? AND collect_id = ?;';
const articleIds = z.array(z.number().int().positive());

export function matchesCollectName(collection: { name: string } | undefined, name: unknown) {
  // The legacy comparison accesses toLowerCase only when the lookup found a row.
  return Boolean(collection && collection.name.toLowerCase() === (name as string).toLowerCase());
}

export function parseCollectArticleSelection(collectId: string, idList: unknown) {
  const parsedCollectId = Number(collectId);
  if (!/^[1-9]\d*$/.test(collectId) || !Number.isSafeInteger(parsedCollectId)) {
    return { ok: false, message: '收藏夹 ID 参数错误' } as const;
  }
  let decoded: unknown;
  try {
    // JSON.parse in Koa coerces repeated query values through Array#toString.
    decoded = JSON.parse(String(idList));
  } catch {
    return { ok: false, message: '文章 ID 参数错误' } as const;
  }
  const parsed = articleIds.safeParse(decoded);
  if (!parsed.success) return { ok: false, message: '文章 ID 参数错误' } as const;
  return { ok: true, collectId: parsedCollectId, ids: parsed.data } as const;
}

export function createCollectService(connection: CollectDatabase) {
  return {
    async addCollect(userId: unknown, name: unknown) {
      const [result] = await connection.execute(buildAddCollectSql(), [userId, name]);
      return result;
    },

    async getCollectByName(userId: unknown, name: unknown): Promise<{ name: string } | undefined> {
      const statement = 'SELECT * FROM collect WHERE user_id = ? and name = ?;';
      const [rows] = await connection.execute(statement, [userId, name]);
      return (rows as { name: string }[])[0];
    },

    async getCollectList(userId: string, offset: string, limit: string) {
      const statement = buildGetCollectListSql();
      const params = buildGetCollectListExecuteParams(userId, String(offset), String(limit));
      const [rows] = await connection.execute(statement, params);
      return rows;
    },

    async hasCollect(articleId: unknown, collectId: unknown) {
      const statement = 'SELECT * FROM article_collect WHERE article_id = ? AND collect_id = ?;';
      const [rows] = await connection.execute(statement, [articleId, collectId]);
      return Boolean((rows as unknown[])[0]);
    },

    async changeCollect(articleId: unknown, collectId: unknown, isCollect: boolean) {
      const statement = isCollect ? deleteMembership : 'INSERT INTO article_collect (article_id,collect_id) VALUES (?,?);';
      const [result] = await connection.execute(statement, [articleId, collectId]);
      return result;
    },

    async toggleCollect(articleId: unknown, collectId: number) {
      const [deleted] = await connection.execute(deleteMembership, [articleId, collectId]);
      if ((deleted as { affectedRows: number }).affectedRows > 0) {
        return { isCollected: false, action: 'uncollected' };
      }

      const statement = 'INSERT INTO article_collect (article_id, collect_id) VALUES (?, ?);';
      await connection.execute(statement, [articleId, collectId]);
      return { isCollected: true, action: 'collected' };
    },

    async removeCollectArticle(collectId: number, idList: number[]) {
      if (!idList || idList.length === 0) return null;
      const statement = `DELETE FROM article_collect WHERE collect_id = ? AND${SqlUtils.queryIn('article_id', idList)};`;
      const [result] = await connection.execute(statement, [collectId, ...idList]);
      return result;
    },

    async getCollectArticle(collectId: number) {
      const [rows] = await connection.execute(buildGetCollectArticleSql(), [collectId]);
      return (rows as unknown[])[0];
    },

    async updateCollect(collectId: string, name: unknown) {
      const [result] = await connection.execute('UPDATE collect SET name = ? WHERE id = ?;', [name, collectId]);
      return result;
    },

    async removeCollect(collectId: string) {
      await connection.execute('DELETE FROM article_collect WHERE collect_id = ?;', [collectId]);
      const [result] = await connection.execute('DELETE FROM collect WHERE id = ?;', [collectId]);
      return result;
    },
  };
}

export type CollectService = ReturnType<typeof createCollectService>;
