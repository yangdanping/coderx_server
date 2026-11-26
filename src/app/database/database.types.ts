/** The query port leaves result shapes unknown so each statement can narrow the data it consumes. */
export interface QueryExecutor {
  execute(sql: string, params?: unknown[]): Promise<readonly [result: unknown, fields: unknown]>;
}

export interface DatabaseTransaction extends QueryExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface DatabaseAdapter extends QueryExecutor {
  getConnection(): Promise<DatabaseTransaction>;
}

export type SqlRow = Record<string, unknown>;

export interface MutationResult {
  affectedRows: number;
  changedRows: number;
  insertId: unknown;
  rowCount: number;
  command: 'INSERT' | 'UPDATE' | 'DELETE';
}
