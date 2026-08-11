const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/image.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const mediaRuntimePath = path.resolve(__dirname, '../../src/service/mediaRuntime.service.js');
const localMediaCleanupPath = path.resolve(__dirname, '../../src/service/localMediaCleanup.service.js');

function loadServiceWithConnection(connectionMock, mediaRuntimeMock = null, localMediaCleanupMock = null) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];
  delete require.cache[mediaRuntimePath];
  delete require.cache[localMediaCleanupPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  if (mediaRuntimeMock) {
    require.cache[mediaRuntimePath] = {
      id: mediaRuntimePath,
      filename: mediaRuntimePath,
      loaded: true,
      exports: mediaRuntimeMock,
    };
  }

  if (localMediaCleanupMock) {
    require.cache[localMediaCleanupPath] = {
      id: localMediaCleanupPath,
      filename: localMediaCleanupPath,
      loaded: true,
      exports: localMediaCleanupMock,
    };
  }

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

          if (/SELECT id FROM article/i.test(statement)) {
            return [[{ id: 9 }], []];
          }
          if (/SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(statement)) {
            return [[{ id: 4 }, { id: 5 }, { id: 6 }], []];
          }
          if (/^\s*SELECT/i.test(statement) && /NOT EXISTS[\s\S]*flow_post_media/i.test(statement)) {
            return [[{ id: 5 }, { id: 6 }], []];
          }
          if (/SELECT id\s+FROM file\s+WHERE article_id/i.test(statement)) {
            return [[{ id: 4 }, { id: 5 }], []];
          }
          if (/SET article_id = \?,\s*draft_id = NULL/i.test(statement)) {
            return [{ affectedRows: 2 }, []];
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
    const result = await service.updateImageArticle(7, 9, [5, 6], 6);

    assert.deepEqual(result, {
      success: true,
      affectedRows: 2,
      deletedCount: 1,
      coverSet: true,
    });

    const executeCalls = calls.filter((call) => call.type === 'execute');
    const articleLockExecute = executeCalls.find((call) => /SELECT id FROM article/i.test(call.statement));
    assert.ok(articleLockExecute, 'Expected owned article lock');
    assert.match(articleLockExecute.statement, /WHERE id = \? AND user_id = \? FOR UPDATE/i);
    assert.deepEqual(articleLockExecute.params, [9, 7]);

    const fileLockExecute = executeCalls.find((call) => /SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(call.statement));
    assert.ok(fileLockExecute, 'Expected bare selected image lock');
    assert.deepEqual(fileLockExecute.params, [7, [4, 5, 6]]);

    const selectedImagesExecute = executeCalls.find((call) => /^\s*SELECT/i.test(call.statement) && /NOT EXISTS[\s\S]*flow_post_media/i.test(call.statement));
    assert.ok(selectedImagesExecute, 'Expected fresh selected image ownership validation');
    assert.match(selectedImagesExecute.statement, /f\.user_id = \?/i);
    assert.match(selectedImagesExecute.statement, /f\.draft_id IS NULL/i);
    assert.doesNotMatch(selectedImagesExecute.statement, /FOR UPDATE/i);
    assert.deepEqual(selectedImagesExecute.params, [[5, 6], 7, 9]);

    const clearCoverExecute = executeCalls.find((call) => /SET is_cover = FALSE/i.test(call.statement));
    assert.ok(clearCoverExecute, 'Expected clear-cover update statement');
    assert.match(clearCoverExecute.statement, /UPDATE image_meta AS im/i);
    assert.match(clearCoverExecute.statement, /FROM file AS f/i);
    assert.doesNotMatch(clearCoverExecute.statement, /INNER JOIN/i);
    assert.deepEqual(clearCoverExecute.params, [9, 7]);

    const setCoverExecute = executeCalls.find((call) => /SET is_cover = TRUE/i.test(call.statement));
    assert.ok(setCoverExecute, 'Expected set-cover update statement');
    assert.match(setCoverExecute.statement, /UPDATE image_meta AS im/i);
    assert.match(setCoverExecute.statement, /FROM file AS f/i);
    assert.doesNotMatch(setCoverExecute.statement, /INNER JOIN/i);
    assert.deepEqual(setCoverExecute.params, [6, 9, 7]);

    const bindImagesExecute = executeCalls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
    assert.ok(bindImagesExecute, 'Expected image binding SQL to clear draft_id');
    assert.match(bindImagesExecute.statement, /\buser_id = \?/i);
    assert.deepEqual(bindImagesExecute.params, [9, [5, 6], 7, 9]);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('updateImageArticle: reads old IDs then locks one owner-filtered sorted union before fresh validation and guarded bind', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement, params) {
          calls.push({ statement, params });
          if (/SELECT id FROM article/i.test(statement)) return [[{ id: 9 }], []];
          if (/SELECT id\s+FROM file\s+WHERE article_id/i.test(statement)) return [[{ id: 1 }], []];
          if (/SELECT f\.id[\s\S]*FROM file f[\s\S]*FOR UPDATE OF f/i.test(statement)) return [[{ id: 1 }, { id: 2 }], []];
          if (/NOT EXISTS[\s\S]*FROM flow_post_media/i.test(statement) && /^\s*SELECT/i.test(statement)) return [[{ id: 2 }], []];
          if (/SET article_id = \?,\s*draft_id = NULL/i.test(statement)) return [{ affectedRows: 1 }, []];
          if (/SELECT[\s\S]+filename[\s\S]+FROM file/i.test(statement)) return [[], []];
          return [{ affectedRows: 1 }, []];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  });

  await service.updateImageArticle(7, 9, [2], null);

  const currentIdsIndex = calls.findIndex((call) => /SELECT id\s+FROM file\s+WHERE article_id/i.test(call.statement));
  const fileLockIndex = calls.findIndex((call) => /SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(call.statement));
  const validationIndex = calls.findIndex((call) => /^\s*SELECT/i.test(call.statement) && /NOT EXISTS[\s\S]*flow_post_media/i.test(call.statement));
  assert.ok(currentIdsIndex >= 0 && fileLockIndex > currentIdsIndex && validationIndex > fileLockIndex);
  assert.doesNotMatch(calls[fileLockIndex].statement, /JOIN flow_post_media/i);
  assert.match(calls[fileLockIndex].statement, /f\.user_id = \?/i);
  assert.deepEqual(calls[fileLockIndex].params, [7, [1, 2]]);
  assert.equal(calls.filter((call) => /FROM file/i.test(call.statement) && /FOR UPDATE/i.test(call.statement)).length, 1);
  const bind = calls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
  assert.match(bind.statement, /NOT EXISTS[\s\S]*FROM flow_post_media fm[\s\S]*fm\.file_id = file\.id/i);
});

test('updateImageArticle: a lost final guarded bind is an exposed 409 instead of a raw database error', async () => {
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement) {
          if (/SELECT id FROM article/i.test(statement)) return [[{ id: 9 }], []];
          if (/SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(statement)) return [[{ id: 5 }], []];
          if (/NOT EXISTS[\s\S]*FROM flow_post_media/i.test(statement) && /^\s*SELECT/i.test(statement)) return [[{ id: 5 }], []];
          if (/SELECT id\s+FROM file\s+WHERE article_id/i.test(statement)) return [[], []];
          if (/SET article_id = \?,\s*draft_id = NULL/i.test(statement)) return [{ affectedRows: 0 }, []];
          return [{ affectedRows: 1 }, []];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  });
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    await assert.rejects(service.updateImageArticle(7, 9, [5], null), (error) => error.name === 'BusinessError' && error.httpStatus === 409);
  } finally {
    console.error = originalConsoleError;
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

          if (/SELECT id FROM article/i.test(statement)) {
            return [[{ id: 9 }], []];
          }
          if (/SELECT id\s+FROM file\s+WHERE article_id = \?[\s\S]+user_id = \?[\s\S]+file_type = 'image'/i.test(statement)) {
            return [[{ id: 7 }, { id: 8 }], []];
          }
          if (/SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(statement)) return [[{ id: 7 }, { id: 8 }], []];

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
    const result = await service.updateImageArticle(7, 9, [], null);

    assert.deepEqual(result, {
      success: true,
      affectedRows: 0,
      deletedCount: 2,
      coverSet: false,
    });

    const executeCalls = calls.filter((call) => call.type === 'execute');
    const clearArticleExecute = executeCalls.find((call) => /SET article_id = NULL/i.test(call.statement));
    assert.ok(clearArticleExecute, 'Expected image clearing SQL to run');
    assert.deepEqual(clearArticleExecute.params, [9, 7]);

    const bindImagesExecute = executeCalls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
    assert.equal(bindImagesExecute, undefined);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('updateImageArticle: promotes the committed article images only after the association transaction commits', async () => {
  const calls = [];
  const imageRows = [
    {
      id: 5,
      filename: 'cover.jpg',
      mimetype: 'image/jpeg',
      size: 123,
      file_type: 'image',
    },
  ];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'beginTransaction' });
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            if (/SELECT id FROM article/i.test(statement)) return [[{ id: 9 }], []];
            if (/SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(statement)) return [[{ id: 5 }], []];
            if (/^\s*SELECT/i.test(statement) && /NOT EXISTS[\s\S]*flow_post_media/i.test(statement)) return [[{ id: 5 }], []];
            if (/SELECT id\s+FROM file\s+WHERE article_id/i.test(statement)) return [[], []];
            if (/SELECT[\s\S]+filename[\s\S]+FROM file/i.test(statement)) return [imageRows, []];
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
    },
    {
      async promotePublishedImages(payload) {
        calls.push({ type: 'promote', payload });
        return { enabled: true, attempted: 2, ready: 2, failed: 0 };
      },
    },
  );

  const result = await service.updateImageArticle(7, 9, [5], 5);

  assert.deepEqual(result, {
    success: true,
    affectedRows: 1,
    deletedCount: 0,
    coverSet: true,
  });
  const commitIndex = calls.findIndex((call) => call.type === 'commit');
  const promoteIndex = calls.findIndex((call) => call.type === 'promote');
  assert.ok(commitIndex >= 0);
  assert.ok(promoteIndex > commitIndex);
  assert.deepEqual(calls[promoteIndex].payload, {
    articleId: 9,
    images: imageRows,
  });
});

test('updateImageArticle: promotion failure keeps the committed local association successful', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'beginTransaction' });
          },
          async execute(statement) {
            if (/SELECT id FROM article/i.test(statement)) return [[{ id: 9 }], []];
            if (/SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(statement)) return [[{ id: 5 }], []];
            if (/^\s*SELECT/i.test(statement) && /NOT EXISTS[\s\S]*flow_post_media/i.test(statement)) return [[{ id: 5 }], []];
            if (/SELECT id\s+FROM file\s+WHERE article_id/i.test(statement)) return [[], []];
            if (/SELECT[\s\S]+filename[\s\S]+FROM file/i.test(statement)) {
              return [
                [
                  {
                    id: 5,
                    filename: 'cover.jpg',
                    mimetype: 'image/jpeg',
                    size: 123,
                    file_type: 'image',
                  },
                ],
                [],
              ];
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
    },
    {
      async promotePublishedImages() {
        calls.push({ type: 'promote' });
        throw new Error('R2 unavailable');
      },
    },
  );
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const result = await service.updateImageArticle(7, 9, [5], null);
    assert.equal(result.success, true);
    assert.equal(
      calls.some((call) => call.type === 'commit'),
      true,
    );
    assert.equal(
      calls.some((call) => call.type === 'promote'),
      true,
    );
    assert.equal(
      calls.some((call) => call.type === 'rollback'),
      false,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('updateImageArticle checks article ownership before any link mutation', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (/SELECT id FROM article/i.test(statement)) return [[], []];
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

  await assert.rejects(() => service.updateImageArticle(7, 9, [41], null), /文章不存在或无权关联图片/);

  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.match(executeCalls[0].statement, /SELECT id FROM article WHERE id = \? AND user_id = \? FOR UPDATE/i);
  assert.deepEqual(executeCalls[0].params, [9, 7]);
  assert.equal(
    executeCalls.some((call) => /^\s*(UPDATE|DELETE|INSERT)/i.test(call.statement)),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'rollback'),
    true,
  );
});

test('updateImageArticle deduplicates IDs and rejects any selected image outside the owner-safe lock', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement, params) {
          calls.push({ statement, params });
          if (/SELECT id FROM article/i.test(statement)) return [[{ id: 9 }], []];
          if (/SELECT id\s+FROM file\s+WHERE article_id/i.test(statement)) return [[], []];
          if (/SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(statement)) return [[{ id: 41 }], []];
          return [{ affectedRows: 1 }, []];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  });

  await assert.rejects(() => service.updateImageArticle(7, 9, [41, 41, 42], null), /部分图片不存在、无权访问或已被关联/);

  const lockCall = calls.find((call) => /SELECT f\.id[\s\S]*FOR UPDATE OF f/i.test(call.statement));
  assert.ok(lockCall);
  assert.deepEqual(lockCall.params, [7, [41, 42]]);
  assert.doesNotMatch(lockCall.statement, /flow_post_media/i);
  assert.equal(
    calls.some((call) => /^\s*UPDATE/i.test(call.statement)),
    false,
  );
});

test('deleteOwnedUnattachedImages refuses existing forbidden images before storage cleanup', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push('begin');
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            if (/LEFT JOIN flow_post_media/i.test(statement)) return [[], []];
            if (/f\.id <> ALL/i.test(statement)) return [[{ id: 42 }], []];
            return [{ affectedRows: 0 }, []];
          },
          async commit() {
            calls.push('commit');
          },
          async rollback() {
            calls.push('rollback');
          },
          release() {
            calls.push('release');
          },
        };
      },
    },
    {
      async deleteR2ObjectsForFiles() {
        calls.push('deleteR2');
      },
    },
    {
      buildLocalCleanupEntries() {
        calls.push('buildCleanup');
        return [];
      },
      async enqueueInTransaction() {
        calls.push('enqueueCleanup');
        return [];
      },
      async processPending() {
        calls.push('processCleanup');
        return {};
      },
    },
  );

  await assert.rejects(() => service.deleteOwnedUnattachedImages(7, [42]), /图片不可删除/);
  assert.equal(calls.includes('deleteR2'), false);
  assert.equal(calls.includes('enqueueCleanup'), false);
  assert.equal(calls.includes('commit'), false);
  assert.equal(calls.includes('rollback'), true);
});

test('deleteOwnedUnattachedImages is missing-row idempotent and durably cleans only owner-unattached non-Flow images', async () => {
  const calls = [];
  const imageRow = { id: 41, filename: 'cover.jpg', file_type: 'image', user_id: 7 };
  const localCleanup = {
    buildLocalCleanupEntries(rows) {
      calls.push({ type: 'buildCleanup', rows });
      return [
        { storageArea: 'image', filename: 'cover.jpg' },
        { storageArea: 'image', filename: 'cover-small.jpg' },
      ];
    },
    async enqueueInTransaction(conn, entries) {
      calls.push({ type: 'enqueueCleanup', entries });
      return [901, 902];
    },
    async processPending({ ids }) {
      calls.push({ type: 'processCleanup', ids });
      return { examined: 2, deleted: 2, missing: 0, failed: 0, pendingIds: [] };
    },
  };
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'begin' });
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            if (/LEFT JOIN flow_post_media/i.test(statement)) return [[imageRow], []];
            if (/f\.id <> ALL/i.test(statement)) return [[], []];
            if (/^\s*DELETE FROM file/i.test(statement)) return [{ affectedRows: 1 }, []];
            return [{ affectedRows: 0 }, []];
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
    },
    {
      async deleteR2ObjectsForFiles(fileIds) {
        calls.push({ type: 'deleteR2', fileIds });
        return { staged: 1, deleted: 1 };
      },
    },
    localCleanup,
  );

  const result = await service.deleteOwnedUnattachedImages(7, [41, 999]);

  const lockCall = calls.find((call) => call.type === 'execute' && /LEFT JOIN flow_post_media/i.test(call.statement));
  assert.match(lockCall.statement, /f\.user_id = \?/i);
  assert.match(lockCall.statement, /f\.article_id IS NULL/i);
  assert.match(lockCall.statement, /f\.draft_id IS NULL/i);
  assert.match(lockCall.statement, /fm\.file_id IS NULL/i);
  assert.match(lockCall.statement, /FOR UPDATE OF f/i);
  assert.deepEqual(lockCall.params, [[41, 999], 7]);

  const deleteCall = calls.find((call) => call.type === 'execute' && /^\s*DELETE FROM file/i.test(call.statement));
  assert.match(deleteCall.statement, /user_id = \?/i);
  assert.match(deleteCall.statement, /article_id IS NULL/i);
  assert.match(deleteCall.statement, /draft_id IS NULL/i);
  assert.match(deleteCall.statement, /NOT EXISTS[\s\S]+flow_post_media/i);
  assert.deepEqual(deleteCall.params, [[41], 7]);

  const r2Index = calls.findIndex((call) => call.type === 'deleteR2');
  const enqueueIndex = calls.findIndex((call) => call.type === 'enqueueCleanup');
  const deleteIndex = calls.findIndex((call) => call === deleteCall);
  const commitIndex = calls.findIndex((call) => call.type === 'commit');
  const processIndex = calls.findIndex((call) => call.type === 'processCleanup');
  assert.ok(r2Index >= 0 && enqueueIndex > r2Index && deleteIndex > enqueueIndex && commitIndex > deleteIndex && processIndex > commitIndex);
  assert.deepEqual(result.imagesToDelete, [imageRow]);
  assert.equal(result.result.affectedRows, 1);
});
