import pg from 'pg';
import { Socket } from 'node:net';
import type { PoolConfig } from 'pg';
import { buildPgPoolConfig } from './pg.config.js';
import { createPgConnectionAdapter, createPgExecutor, type PgQueryClient, type PgSession } from './pg.utils.js';

const INT8_OID = 20;

export function parseSafeInt8(value: string): number;
export function parseSafeInt8(value: string | null | undefined): number | null | undefined {
  if (value == null) return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL int8 超出 JS 安全整数范围: ${value}`);
  }
  return parsed;
}

interface SqlLogger {
  debug(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

interface PgPool extends PgQueryClient {
  on(event: 'error', listener: (error: Error) => void): void;
  connect(): Promise<PgSession>;
  end(): Promise<void>;
}

function pgOptions(config: Parameters<typeof buildPgPoolConfig>[0]): PoolConfig {
  const { port, ...options } = buildPgPoolConfig(config);
  const parsedPort = port === undefined ? undefined : Number.parseInt(port, 10);
  if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
    throw new Error('Invalid PostgreSQL PGPORT');
  }
  return parsedPort === undefined ? options : { ...options, port: parsedPort };
}

export function createPgReadinessCheck(config: Parameters<typeof buildPgPoolConfig>[0]) {
  const options = pgOptions(config);
  let pending: Promise<boolean> | undefined;

  async function probe() {
    // Isolate health deadlines from business queries and the business pool's queue.
    const socket = new Socket();
    const client = new pg.Client({
      ...options,
      stream: () => socket,
      connectionTimeoutMillis: 400,
      pipeline: false,
    });
    client.on('error', () => {}); // Connect and query reject separately. Never log probe errors or credentials.
    const deadline = setTimeout(() => socket.destroy(), 900);
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const query = { text: 'SELECT 1', query_timeout: 400 };
      await client.query(query);
      return true;
    } catch {
      return false;
    } finally {
      try {
        if (connected) await client.end();
      } finally {
        clearTimeout(deadline);
        socket.destroy();
      }
    }
  }

  return () => pending ??= probe().finally(() => { pending = undefined; });
}

export function createPgClient(
  config: Parameters<typeof buildPgPoolConfig>[0],
  sqlLogger: SqlLogger,
  createPool: (options: PoolConfig) => PgPool = options => new pg.Pool(options),
) {
  pg.types.setTypeParser(INT8_OID, parseSafeInt8);
  const pool = createPool(pgOptions(config));
  pool.on('error', error => console.error('❌ PostgreSQL 连接池异常:', error.message));

  const executeWithLogging = async (client: ReturnType<typeof createPgExecutor>, sql: string, params: unknown[]) => {
    const startTime = Date.now();
    // Registration writes include a password hash; neither parameters nor driver errors are safe to log.
    const credentialQuery = /\bpassword\b/i.test(sql);

    try {
      sqlLogger.debug(`执行SQL: ${sql.trim()} | 参数: ${credentialQuery ? '[REDACTED]' : JSON.stringify(params)}`);
      const result = await client.execute(sql, params);
      sqlLogger.info(`✓ SQL执行成功 (${Date.now() - startTime}ms)`);
      return result;
    } catch (error) {
      const reason = credentialQuery ? 'credential query failed' : error instanceof Error ? error.message : String(error);
      sqlLogger.error(`✗ SQL执行失败 (${Date.now() - startTime}ms): ${reason}`);
      throw error;
    }
  };

  const executor = createPgExecutor(pool);
  return {
    execute(sql: string, params: unknown[] = []) {
      return executeWithLogging(executor, sql, params);
    },
    async getConnection() {
      const connection = createPgConnectionAdapter(await pool.connect());
      return {
        execute(sql: string, params: unknown[] = []) {
          return executeWithLogging(connection, sql, params);
        },
        beginTransaction: connection.beginTransaction,
        commit: connection.commit,
        rollback: connection.rollback,
        release: connection.release,
      };
    },
    async end() {
      await pool.end();
    },
  };
}
