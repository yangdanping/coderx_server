import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarRepository } from '../../src/service/avatar/avatar.service.js';

function loadServiceWithConnection(connectionMock) {
  return createAvatarRepository(connectionMock);
}

test('addAvatar: pg requests insertId through RETURNING id when transactional connection is supplied', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute() {
      throw new Error('Expected transactional connection execute to be used');
    },
  });

  const transactionalConn = {
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ insertId: /RETURNING\s+id/i.test(statement) ? 231 : 0, affectedRows: 1 }, []];
    },
  };

  const result = await service.addAvatar(9, 'avatar.png', 'image/png', 321, transactionalConn);

  assert.equal(result.insertId, 231);
  assert.match(calls[0].statement, /INSERT INTO avatar \(user_id,filename, mimetype, size\) VALUES \(\?,\?,\?,\?\) RETURNING id;$/i);
  assert.deepEqual(calls[0].params, [9, 'avatar.png', 'image/png', 321]);
});
