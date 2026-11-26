import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPgClient } from '../../src/app/database/pg.factory.js';

const INT8_OID = 20;

test('pg.client registers int8 parser so bigint columns become safe JS numbers', async (t) => {
  const { types } = pg;
  const originalParser = types.getTypeParser(INT8_OID, 'text');
  t.after(() => types.setTypeParser(INT8_OID, originalParser));
  createPgClient({ DATABASE_URL: 'postgresql://unused.invalid/test' }, {
    debug() {},
    info() {},
    error() {},
  }, () => ({
    async query() { assert.fail('parser registration must not query PostgreSQL'); },
    async connect() { assert.fail('parser registration must not connect to PostgreSQL'); },
    async end() {},
    on() {},
  }));

  const parseInt8 = types.getTypeParser(INT8_OID, 'text');
  assert.equal(parseInt8('130'), 130);
  assert.equal(typeof parseInt8('130'), 'number');
  assert.throws(() => parseInt8(String(Number.MAX_SAFE_INTEGER + 1)), /安全整数|safe integer/i);
});
