import type { FieldDef } from 'pg';
import type { DatabaseTransaction, MutationResult, SqlRow } from './database.types.js';

interface PgResult {
  command: string;
  rows: SqlRow[];
  fields: FieldDef[];
  rowCount: number | null;
}

export interface PgQueryClient {
  query(sql: string, params?: unknown[]): Promise<PgResult>;
}

export interface PgSession extends PgQueryClient {
  release(): void;
}

type PgExecution = [result: SqlRow[] | MutationResult, fields: FieldDef[]];

const QUESTION_MARK = '?';
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKSLASH = '\\';

export function convertQuestionPlaceholders(sql: string): string {
  let parameterIndex = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let result = '';

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const previousChar = sql[index - 1];
    const nextChar = sql[index + 1];

    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && nextChar === '-') {
      inLineComment = true;
      result += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      result += char;
      continue;
    }

    if (inLineComment) {
      result += char;
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      result += char;
      if (previousChar === '*' && char === '/') {
        inBlockComment = false;
      }
      continue;
    }

    if (char === SINGLE_QUOTE && previousChar !== BACKSLASH && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += char;
      continue;
    }

    if (char === DOUBLE_QUOTE && previousChar !== BACKSLASH && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
      continue;
    }

    if (char === QUESTION_MARK && !inSingleQuote && !inDoubleQuote) {
      parameterIndex += 1;
      result += `$${parameterIndex}`;
      continue;
    }

    result += char;
  }

  return result;
}

export function adaptPgResult(result: PgResult): PgExecution {
  const { command, fields, rows } = result;
  if (command === 'INSERT' || command === 'UPDATE' || command === 'DELETE') {
    const firstRow = rows[0];
    const rowCount = result.rowCount ?? 0;
    return [{
      affectedRows: rowCount,
      changedRows: rowCount,
      insertId: firstRow?.id ?? firstRow?.insertId ?? 0,
      rowCount,
      command,
    }, fields];
  }
  return [rows, fields];
}

export function createPgExecutor(client: PgQueryClient) {
  return {
    async execute(sql: string, params: unknown[] = []): Promise<PgExecution> {
      return adaptPgResult(await client.query(convertQuestionPlaceholders(sql), params));
    },
  };
}

export interface PgTransaction extends DatabaseTransaction {
  execute: ReturnType<typeof createPgExecutor>['execute'];
  begin(): Promise<void>;
}

export function createPgConnectionAdapter(client: PgSession): PgTransaction {
  const begin = async () => {
    await client.query('BEGIN');
  };

  return {
    ...createPgExecutor(client),
    begin,
    beginTransaction: begin,
    async commit() {
      await client.query('COMMIT');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
    release() {
      client.release();
    },
  };
}
