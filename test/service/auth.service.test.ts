import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../../src/service/auth/auth.service.js';

function loadServiceWithConnection(connectionMock) {
  return createAuthService(connectionMock);
}

test('checkStatus: pg executes against quoted user table', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ status: 1 }], []];
    },
  });

  const status = await service.checkStatus(7);

  assert.equal(status, 1);
  assert.match(calls[0].statement, /SELECT status FROM "user" WHERE id = \?;/i);
  assert.deepEqual(calls[0].params, [7]);
});
