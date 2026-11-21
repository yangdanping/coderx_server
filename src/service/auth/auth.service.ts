import type { QueryExecutor } from '../../app/database/database.types.js';
import { buildCheckStatusSql } from '../sql/auth.sql.js';

type AuthDatabase = QueryExecutor;
const ownedTables = new Set(['article', 'comment', 'video', 'tag', 'collect']);

export function isOwnedTable(tableName: string) {
  return ownedTables.has(tableName);
}

export function createAuthService(connection: AuthDatabase) {
  return {
    async checkPermission(tableName: string, dataId: string, userId: unknown) {
      if (!isOwnedTable(tableName)) return false;
      const statement = `SELECT * FROM ${tableName} WHERE id = ? AND user_id = ?;`;
      const [rows] = await connection.execute(statement, [dataId, userId]);
      return Boolean((rows as unknown[])[0]);
    },

    async checkStatus(userId: unknown) {
      const [rows] = await connection.execute(buildCheckStatusSql(), [userId]);
      return (rows as { status: unknown }[])[0].status;
    },
  };
}
