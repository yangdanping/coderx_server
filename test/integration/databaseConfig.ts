import assert from 'node:assert/strict';
import type { PoolConfig } from 'pg';
import { buildPgPoolConfig } from '../../src/app/database/pg.config.js';

export function integrationDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const { DATABASE_URL, PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD } = env;
  const url = DATABASE_URL ? new URL(DATABASE_URL) : undefined;
  assert.ok(!url || ['host', 'port', 'database', 'dbname'].every(key => !url.searchParams.has(key)), 'Put the integration database address and name in the URL itself');
  const host = url?.hostname ?? PGHOST ?? '';
  const database = url?.pathname.slice(1) ?? PGDATABASE ?? '';
  assert.ok(['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host.toLowerCase()), 'Integration tests require a local PostgreSQL host');
  assert.match(database, /(?:^|[_-])test(?:$|[_-])/i, 'Integration tests require a dedicated test database');

  const { port, ...options } = buildPgPoolConfig({ DATABASE_URL, PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD });
  return port === undefined ? options : { ...options, port: Number(port) };
}
