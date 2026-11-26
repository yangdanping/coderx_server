import pg from 'pg';
import { buildPgPoolConfig } from '../app/database/pg.config.js';
import { createPgConnectionAdapter, createPgExecutor } from '../app/database/pg.utils.js';

const INT8_OID = 20;

export function configureIngestTypeParsers() {
  pg.types.setTypeParser(INT8_OID, (value) => {
    if (value == null) return value;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`PostgreSQL int8 exceeds the JavaScript safe integer range: ${value}`);
    }
    return parsed;
  });
}

function createIngestDatabase(config: Parameters<typeof buildPgPoolConfig>[0]) {
  const { port, ...options } = buildPgPoolConfig(config);
  const parsedPort = port === undefined ? undefined : Number.parseInt(port, 10);
  if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)) {
    throw new Error('Invalid PostgreSQL PGPORT');
  }
  configureIngestTypeParsers();
  const pool = new pg.Pool(parsedPort === undefined ? options : { ...options, port: parsedPort });

  return {
    ...createPgExecutor(pool),
    async getConnection() {
      const client = await pool.connect();
      return createPgConnectionAdapter(client);
    },
    async end() {
      await pool.end();
    },
  };
}

export { createIngestDatabase };
