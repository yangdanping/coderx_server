const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const hash = 'registration-password-hash-sentinel'; // pragma: allowlist secret
const statement = 'INSERT INTO "user" (name, password) VALUES (?, ?) RETURNING id;';
const pgPath = require.resolve('pg');
const root = path.resolve(__dirname, '../..');
const records = [];
const queries = [];
let failure;
class Pool extends EventEmitter {
  async query(sql, params) {
    queries.push({ sql, params });
    if (failure) throw failure;
    return { rows: [{ id: 42 }], rowCount: 1, command: 'INSERT' };
  }
  async connect() {
    return this;
  }
  release() {}
  async end() {}
}
function inject(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
inject(pgPath, { Pool, types: { setTypeParser() {} } });
inject(path.join(root, 'src/app/config.js'), { DATABASE_URL: 'postgresql://unused.invalid/test' });
inject(path.join(root, 'src/app/logger.js'), {
  sqlLogger: Object.fromEntries(['debug', 'info', 'error'].map((method) => [method, (message) => records.push(message)])),
});
const client = require('../../src/app/database/pg.client');

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
