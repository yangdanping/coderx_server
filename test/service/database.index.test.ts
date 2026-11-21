import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgClient } from '../../src/app/database/pg.factory.js';

test('PostgreSQL client exposes pool and transaction execution and closes its pool', async () => {
  const calls: unknown[] = [];
  const connection = {
    async query(sql: string, params?: unknown[]) {
      calls.push(['transaction', sql, params]);
      return { rows: [{ id: 41 }], rowCount: 1, fields: [], command: 'SELECT' };
    },
    release() { calls.push(['release']); },
  };
  const database = createPgClient({ DATABASE_URL: 'postgresql://unused.invalid/test' }, {
    debug() {},
    info() {},
    error() {},
  }, () => ({
    async query(sql, params) {
      calls.push(['pool', sql, params]);
      return { rows: [{ id: 42 }], rowCount: 1, fields: [], command: 'SELECT' };
    },
    async connect() { return connection; },
    async end() { calls.push(['end']); },
    on() {},
  }));

  assert.deepEqual(await database.execute('SELECT ?;', [42]), [[{ id: 42 }], []]);
  const session = await database.getConnection();
  assert.deepEqual(await session.execute('SELECT ?;', [41]), [[{ id: 41 }], []]);
  session.release();
  await database.end();

  assert.deepEqual(calls, [
    ['pool', 'SELECT $1;', [42]],
    ['transaction', 'SELECT $1;', [41]],
    ['release'],
    ['end'],
  ]);
});
