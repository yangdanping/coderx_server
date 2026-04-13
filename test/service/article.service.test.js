const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const BusinessError = require('@/errors/BusinessError');
const servicePath = path.resolve(__dirname, '../../src/service/article.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');
const utilsPath = path.resolve(__dirname, '../../src/utils/index.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[urlsPath];
  delete require.cache[utilsPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  require.cache[urlsPath] = {
    id: urlsPath,
    filename: urlsPath,
    loaded: true,
    exports: {
      baseURL: 'https://api.example',
      redirectURL: 'https://app.example',
    },
  };

  require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    exports: {},
  };

  return require(servicePath);
}

function createConnMock(handlers) {
  const calls = [];
  const conn = {
    async execute(statement, params) {
      calls.push({ target: 'conn', statement, params });
      if (handlers.execute) {
        return handlers.execute(statement, params, calls);
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      if (/UPDATE draft/i.test(statement) && /consumed/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 55 }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      return [[], []];
    },
    async beginTransaction() {
      calls.push({ target: 'conn', op: 'beginTransaction' });
    },
    async commit() {
      calls.push({ target: 'conn', op: 'commit' });
    },
    async rollback() {
      calls.push({ target: 'conn', op: 'rollback' });
    },
    release() {
      calls.push({ target: 'conn', op: 'release' });
    },
  };
  conn.calls = calls;
  return conn;
}

test('addArticle: pg requests insertId through RETURNING id (transactional path)', async () => {
  const conn = createConnMock({});
  const poolCalls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      poolCalls.push('getConnection');
      return conn;
    },
  });

  const result = await service.addArticle(9, 'Title', '<p>Content</p>');

  assert.equal(result.insertId, 301);
  const insertCall = conn.calls.find((c) => c.statement && /INSERT INTO article \(user_id,title, content\) VALUES \(\?,\?,\?\) RETURNING id;/i.test(c.statement));
  assert.ok(insertCall, 'expected INSERT article on connection');
  assert.deepEqual(insertCall.params, [9, 'Title', '<p>Content</p>']);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'commit' }, { op: 'release' }],
  );
  assert.deepEqual(poolCalls, ['getConnection']);
});

test('addArticle with draftId: locks standalone draft, inserts article, consumes draft, commits', async () => {
  const conn = createConnMock({});
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await service.addArticle(9, 'Title', '<p>Content</p>', 12);

  const stmts = conn.calls.filter((c) => c.statement).map((c) => c.statement);
  assert.match(stmts[0], /FROM draft/i);
  assert.match(stmts[0], /article_id IS NULL/i);
  assert.match(stmts[0], /FOR UPDATE/i);
  assert.match(stmts[1], /INSERT INTO article/i);
  assert.match(stmts[2], /UPDATE draft/i);
  assert.match(stmts[2], /consumed_article_id/i);
  assert.equal(stmts.some((statement) => /UPDATE file/i.test(statement)), false);
  const lockCall = conn.calls.find((c) => /FROM draft/i.test(c.statement || ''));
  assert.deepEqual(lockCall.params, [12, 9]);
  const consumeCall = conn.calls.find((c) => /UPDATE draft/i.test(c.statement || '') && /consumed/i.test(c.statement));
  assert.deepEqual(consumeCall.params, [12, 9, 301]);
});

test('addArticle with invalid draftId: rejects before opening transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection');
    },
  });

  await assert.rejects(
    () => service.addArticle(9, 'Title', '<p>Content</p>', 'oops'),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.message, '参数错误: draftId 必须是正整数');
      return true;
    }
  );

  assert.equal(getConnectionCalled, false);
});

test('addArticle with draftId: missing draft after lock throws 404 and rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[], []];
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.addArticle(9, 'Title', '<p>x</p>', 12), (err) => {
    assert.ok(err instanceof BusinessError);
    assert.equal(err.httpStatus, 404);
    assert.equal(err.message, '草稿不存在');
    return true;
  });
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('addArticle with draftId: consume affects no rows rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 12 }], []];
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        return [{ affectedRows: 0, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.addArticle(9, 'Title', '<p>x</p>', 12), (err) => {
    assert.ok(err instanceof BusinessError);
    assert.equal(err.message, '草稿不存在');
    return true;
  });
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('addArticle with draftId: consume execute throws rolls back', async () => {
  const boom = new Error('db consume failed');
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 12 }], []];
      }
      if (/INSERT INTO article/i.test(statement)) {
        return [{ insertId: 301, affectedRows: 1 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        throw boom;
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.addArticle(9, 'Title', '<p>x</p>', 12), boom);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update without draftId: updates article in a transaction', async () => {
  const conn = createConnMock({});
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await service.update(7, 'T', '<p>C</p>', 100, null);

  const updateCall = conn.calls.find((c) => c.statement && /UPDATE article SET title/i.test(c.statement));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.params, ['T', '<p>C</p>', 100]);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'commit' }, { op: 'release' }],
  );
});

test('update with draftId: locks article-linked draft then updates then consumes', async () => {
  const conn = createConnMock({});
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await service.update(7, 'T', '<p>C</p>', 100, 44);

  const lockCall = conn.calls.find((c) => /FROM draft/i.test(c.statement || ''));
  assert.ok(lockCall);
  assert.match(lockCall.statement, /article_id = \$3/i);
  assert.deepEqual(lockCall.params, [44, 7, 100]);
  const consumeCall = conn.calls.find((c) => /UPDATE draft/i.test(c.statement || '') && /consumed/i.test(c.statement));
  assert.deepEqual(consumeCall.params, [44, 7, 100]);
  const stmts = conn.calls.filter((c) => c.statement).map((c) => c.statement);
  assert.equal(stmts.some((statement) => /UPDATE file/i.test(statement)), false);
});

test('update with invalid draftId: rejects before opening transaction', async () => {
  let getConnectionCalled = false;
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      getConnectionCalled = true;
      throw new Error('should not open connection');
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', '<p>C</p>', 100, 'oops'),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.message, '参数错误: draftId 必须是正整数');
      return true;
    }
  );

  assert.equal(getConnectionCalled, false);
});

test('update with draftId: article update affects no rows and rolls back without consuming draft', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 44 }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 0, insertId: 0 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', '<p>C</p>', 100, 44),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, '文章不存在');
      return true;
    }
  );

  const executeCalls = conn.calls.filter((c) => c.statement);
  assert.equal(executeCalls.filter((c) => /UPDATE draft/i.test(c.statement)).length, 0);
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update with draftId: consume affects no rows and rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 44 }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        return [{ affectedRows: 0, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(
    () => service.update(7, 'T', '<p>C</p>', 100, 44),
    (err) => {
      assert.ok(err instanceof BusinessError);
      assert.equal(err.httpStatus, 404);
      assert.equal(err.message, '草稿不存在');
      return true;
    }
  );

  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update with draftId: consume execute throws and rolls back', async () => {
  const boom = new Error('draft consume failed');
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[{ id: 44 }], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/UPDATE draft/i.test(statement)) {
        throw boom;
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.update(7, 'T', '<p>C</p>', 100, 44), boom);

  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});

test('update with draftId: missing draft throws 404 and rolls back', async () => {
  const conn = createConnMock({
    execute(statement) {
      if (/FROM draft/i.test(statement)) {
        return [[], []];
      }
      if (/UPDATE article SET title/i.test(statement)) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      return [[], []];
    },
  });
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return conn;
    },
  });

  await assert.rejects(() => service.update(7, 'T', '<p>C</p>', 100, 44), (err) => {
    assert.ok(err instanceof BusinessError);
    assert.equal(err.httpStatus, 404);
    assert.equal(err.message, '草稿不存在');
    return true;
  });
  assert.deepEqual(
    conn.calls.filter((c) => c.op).map((c) => ({ op: c.op })),
    [{ op: 'beginTransaction' }, { op: 'rollback' }, { op: 'release' }],
  );
});
