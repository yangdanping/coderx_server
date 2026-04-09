const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { types } = require('pg');

const clientPath = path.resolve(__dirname, '../../src/app/database/pg.client.js');
const INT8_OID = 20;

test('pg.client: registers int8 parser so bigint columns become safe JS numbers', async (t) => {
  const originalParser = types.getTypeParser(INT8_OID, 'text');
  let clientModule;

  t.after(async () => {
    types.setTypeParser(INT8_OID, originalParser);
    if (clientModule?.end) {
      await clientModule.end();
    }
    delete require.cache[clientPath];
  });

  delete require.cache[clientPath];
  clientModule = require(clientPath);

  const parseInt8 = types.getTypeParser(INT8_OID, 'text');
  assert.equal(parseInt8('130'), 130);
  assert.equal(typeof parseInt8('130'), 'number');
  assert.throws(() => parseInt8(String(Number.MAX_SAFE_INTEGER + 1)), /安全整数|safe integer/i);
});
