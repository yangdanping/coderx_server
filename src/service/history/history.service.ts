import type { QueryExecutor } from '../../app/database/database.types.js';
import { hydrateAvatarUrls } from '../../utils/publicAssetUrls.js';
import {
  buildAddHistorySql,
  buildGetUserHistorySql,
  buildUserHistoryExecuteParams,
} from '../sql/history.sql.js';

type HistoryDatabase = QueryExecutor;
type HistoryPagination = string | string[] | undefined;

export function formatHistoryPage(
  rows: Record<string, unknown>[],
  total: unknown,
  offset: HistoryPagination,
  limit: HistoryPagination,
) {
  for (const row of rows) {
    if (row.status) {
      row.title = '文章已被封禁';
      row.excerpt = '文章已被封禁';
    } else {
      row.excerpt = typeof row.excerpt === 'string' ? row.excerpt.slice(0, 50) : '';
    }
  }
  return {
    result: rows,
    total,
    pageNum: Math.floor(Number(offset) / Number(limit)) + 1,
    pageSize: parseInt(String(limit)),
  };
}

export function createHistoryService(connection: HistoryDatabase, baseURL: string, redirectURL: string) {
  return {
    async addHistory(userId: unknown, articleId: unknown) {
      const [result] = await connection.execute(buildAddHistorySql(), [userId, articleId]);
      return result;
    },

    async getUserHistory(userId: unknown, offset: HistoryPagination, limit: HistoryPagination) {
      const statement = buildGetUserHistorySql(baseURL, redirectURL);
      const [rows] = await connection.execute(statement, buildUserHistoryExecuteParams(userId, offset, limit));
      return hydrateAvatarUrls(rows, baseURL) as Record<string, unknown>[];
    },

    async getUserHistoryCount(userId: unknown) {
      const statement = `
        SELECT COUNT(*) as total
        FROM article_history ah
        LEFT JOIN article a ON ah.article_id = a.id
        WHERE ah.user_id = ? AND a.id IS NOT NULL;
      `;
      const [rows] = await connection.execute(statement, [userId]);
      return (rows as { total: unknown }[])[0].total;
    },

    async deleteHistory(userId: unknown, articleId: string) {
      const statement = `
        DELETE FROM article_history
        WHERE user_id = ? AND article_id = ?;
      `;
      const [result] = await connection.execute(statement, [userId, articleId]);
      return result;
    },

    async clearUserHistory(userId: unknown) {
      const [result] = await connection.execute('DELETE FROM article_history WHERE user_id = ?;', [userId]);
      return result;
    },

    async hasViewed(userId: unknown, articleId: string) {
      const statement = `
        SELECT id FROM article_history
        WHERE user_id = ? AND article_id = ?;
      `;
      const [rows] = await connection.execute(statement, [userId, articleId]);
      return (rows as { id: unknown }[]).length > 0;
    },
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
