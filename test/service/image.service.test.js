const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/image.service.js');
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

test('addImage: pg transaction requests insertId through RETURNING id and uses it for image_meta', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (calls.filter((call) => call.type === 'execute').length === 1) {
            return [{ insertId: /RETURNING\s+id/i.test(statement) ? 81 : 0, affectedRows: 1 }, []];
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
  });

  const result = await service.addImage(3, 'a.png', 'image/png', 123, 640, 480);

  assert.equal(result.insertId, 81);
  const firstExecute = calls.find((call) => call.type === 'execute');
  assert.match(firstExecute.statement, /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'image'\) RETURNING id;/i);
  assert.deepEqual(firstExecute.params, [3, 'a.png', 'image/png', 123]);

  const secondExecute = calls.filter((call) => call.type === 'execute')[1];
  assert.equal(secondExecute.statement, 'INSERT INTO image_meta (file_id, width, height, is_cover) VALUES (?,?,?,FALSE);');
  assert.deepEqual(secondExecute.params, [81, 640, 480]);
});

test('updateImageArticle: pg uses update-from SQL for cover reset and cover set', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });

          if (/SELECT id\s+FROM file/i.test(statement)) {
            return [[{ id: 4 }, { id: 5 }], []];
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
  });

  console.log = () => {};

  try {
    const result = await service.updateImageArticle(9, [5, 6], 6);

    assert.deepEqual(result, {
      success: true,
      affectedRows: 2,
      deletedCount: 1,
      coverSet: true,
    });

    const executeCalls = calls.filter((call) => call.type === 'execute');
    const clearCoverExecute = executeCalls.find((call) => /SET is_cover = FALSE/i.test(call.statement));
    assert.ok(clearCoverExecute, 'Expected clear-cover update statement');
    assert.match(clearCoverExecute.statement, /UPDATE image_meta AS im/i);
    assert.match(clearCoverExecute.statement, /FROM file AS f/i);
    assert.doesNotMatch(clearCoverExecute.statement, /INNER JOIN/i);
    assert.deepEqual(clearCoverExecute.params, [9]);

    const setCoverExecute = executeCalls.find((call) => /SET is_cover = TRUE/i.test(call.statement));
    assert.ok(setCoverExecute, 'Expected set-cover update statement');
    assert.match(setCoverExecute.statement, /UPDATE image_meta AS im/i);
    assert.match(setCoverExecute.statement, /FROM file AS f/i);
    assert.doesNotMatch(setCoverExecute.statement, /INNER JOIN/i);
    assert.deepEqual(setCoverExecute.params, [6, 9]);

    const bindImagesExecute = executeCalls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
    assert.ok(bindImagesExecute, 'Expected image binding SQL to clear draft_id');
    assert.deepEqual(bindImagesExecute.params, [9, 5, 6]);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('updateImageArticle: empty imageIds still clears old article image links without rebinding', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });

          if (/SELECT id\s+FROM file\s+WHERE article_id = \? AND file_type = 'image'/i.test(statement)) {
            return [[{ id: 7 }, { id: 8 }], []];
          }

          return [{ affectedRows: 2 }, []];
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
  });

  console.log = () => {};

  try {
    const result = await service.updateImageArticle(9, [], null);

    assert.deepEqual(result, {
      success: true,
      affectedRows: 0,
      deletedCount: 2,
      coverSet: false,
    });

    const executeCalls = calls.filter((call) => call.type === 'execute');
    const clearArticleExecute = executeCalls.find((call) => /SET article_id = NULL/i.test(call.statement));
    assert.ok(clearArticleExecute, 'Expected image clearing SQL to run');
    assert.deepEqual(clearArticleExecute.params, [9]);

    const bindImagesExecute = executeCalls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
    assert.equal(bindImagesExecute, undefined);
  } finally {
    console.log = originalConsoleLog;
  }
});
