import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPgClient } from '../../src/app/database/pg.factory.js';

const hash = 'registration-password-hash-sentinel'; // pragma: allowlist secret
const statement = 'INSERT INTO "user" (name, password) VALUES (?, ?) RETURNING id;';
const records: string[] = [];
const queries: { sql: string; params: unknown[] }[] = [];
let failure: Error | undefined;
class Pool extends EventEmitter {
  async query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    if (failure) throw failure;
    return { rows: [{ id: 42 }], rowCount: 1, fields: [], command: 'INSERT' };
  }
  async connect() {
    return this;
  }
  release() {}
  async end() {}
}
function record(message: string) {
  records.push(message);
}
const sqlLogger = { debug: record, info: record, error: record };
const client = createPgClient({ DATABASE_URL: 'postgresql://unused.invalid/test' }, sqlLogger, () => new Pool());

test('password SQL sends real parameters to pg without passing them to loggers', async () => {
  records.length = 0;
  queries.length = 0;
  await client.execute(statement, ['alice', hash]);
  const conn = await client.getConnection();
  await conn.execute(statement, ['alice', hash]);
  conn.release();
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => query.params[1] === hash));
  assert.ok(!records.join('\n').includes(hash), 'SQL logger received the registration password hash');
});

test('password SQL failure logs omit credential-bearing database messages', async () => {
  records.length = 0;
  failure = new Error(`failed password value: ${hash}`);
  try {
    await assert.rejects(client.execute(statement, ['alice', hash]), (error) => error === failure);
    assert.ok(!records.join('\n').includes(hash), 'SQL error logger received credentials');
  } finally {
    failure = undefined;
  }
});

test('ordinary SQL keeps useful parameter diagnostics', async () => {
  records.length = 0;
  await client.execute('SELECT id FROM "user" WHERE name = ?;', ['alice']);
  assert.ok(records.some((message) => message.includes('alice')));
});

test('an invalid explicit PostgreSQL port cannot fall back to the default pool port', () => {
  const config = { PGHOST: '127.0.0.1', PGDATABASE: 'temporary', PGUSER: 'fixture', PGPASSWORD: 'fixture' };
  for (const PGPORT of ['0', 'invalid', '65536']) {
    assert.throws(() => createPgClient({ ...config, PGPORT }, sqlLogger, () => {
      assert.fail('pool creation must not proceed with an invalid explicit port');
    }), /Invalid PostgreSQL PGPORT/);
  }
});
