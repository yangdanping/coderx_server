import type { QueryExecutor } from '../../app/database/database.types.js';

export async function queryRows<Row extends object>(executor: QueryExecutor, sql: string, params?: unknown[]): Promise<Row[]> {
  const [result] = await executor.execute(sql, params);
  if (!Array.isArray(result)) throw new Error('Expected PostgreSQL result rows');
  // Callers supply the row shape declared by their SELECT. Keep existing pg
  // values, including nullable fields and bigint handling, intact.
  return result as Row[];
}

export function affectedRows(result: unknown): number | undefined {
  return typeof result === 'object' && result !== null && 'affectedRows' in result && typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
}
