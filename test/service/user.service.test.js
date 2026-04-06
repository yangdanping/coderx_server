const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/user.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  return require(servicePath);
}

test('getUserByName: pg executes query against quoted user table', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 1, name: 'alice' }], []];
    },
  });

  const user = await service.getUserByName('alice');

  assert.deepEqual(user, { id: 1, name: 'alice' });
  assert.match(calls[0].statement, /FROM\s+"user"\s+WHERE\s+name\s*=\s*\?/i);
  assert.doesNotMatch(calls[0].statement, /FROM\s+user\s+WHERE\s+name\s*=\s*\?/i);
  assert.deepEqual(calls[0].params, ['alice']);
});

test('getCommentById: pg uses limit-first params and pg-safe author SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 2, title: 'hello', content: 'world', likes: 0 }], []];
    },
  });

  const comments = await service.getCommentById(9, '20', '10');

  assert.deepEqual(comments, [{ id: 2, title: 'hello', content: 'world', likes: 0 }]);
  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+u\.id\s*=\s*c\.user_id/i);
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.deepEqual(calls[0].params, [9, '10', '20']);
});

test('toggleLike: invalid table name throws BusinessError instead of ReferenceError', async () => {
  const service = loadServiceWithConnection({
    dialect: 'mysql',
    async execute() {
      throw new Error('execute should not be called for invalid table name');
    },
  });

  await assert.rejects(
    () => service.toggleLike('invalid_table', 1, 2),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.message, '非法的表名');
      assert.equal(error.httpStatus, 400);
      return true;
    }
  );
});

test('addUser: pg quotes reserved user table in insert statement while keeping transaction flow', async () => {
  const calls = [];
  const connectionMock = {
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (calls.filter((call) => call.type === 'execute').length === 1) {
            return [{ insertId: /RETURNING\s+id/i.test(statement) ? 11 : 0, affectedRows: 1 }, []];
          }
          return [{ affectedRows: 1 }, []];
        },
        async commit() {
          calls.push({ type: 'commit' });
        },
        async rollback() {
          calls.push({ type: 'rollback' });
        },
        release() {
          calls.push({ type: 'release' });
        },
      };
    },
  };

  const service = loadServiceWithConnection(connectionMock);
  const result = await service.addUser({ name: 'alice', password: 'secret' }); // pragma: allowlist secret

  assert.equal(result.insertId, 11);
  const firstExecute = calls.find((call) => call.type === 'execute');
  assert.match(firstExecute.statement, /INSERT INTO\s+"user"\s*\(name,\s*password\)\s*VALUES\s*\(\?,\s*\?\)/i);
  assert.match(firstExecute.statement, /RETURNING\s+id/i);
  assert.deepEqual(firstExecute.params, ['alice', 'secret']);
  const secondExecute = calls.filter((call) => call.type === 'execute')[1];
  assert.deepEqual(secondExecute.params, [11]);
});
