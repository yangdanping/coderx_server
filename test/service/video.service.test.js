const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/video.service.js');
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

  require.cache[mediaRuntimePath] = {
    id: mediaRuntimePath,
    filename: mediaRuntimePath,
    loaded: true,
    exports: mediaRuntimeMock || {
      async promotePublishedVideos() {
        return { attempted: 0, ready: 0, inProgress: 0, failed: 0 };
      },
      async deleteR2ObjectsForFiles() {
        return { staged: 0, deleted: 0 };
      },
    },
  };

  require.cache[localMediaCleanupPath] = {
    id: localMediaCleanupPath,
    filename: localMediaCleanupPath,
    loaded: true,
    exports: localMediaCleanupMock || {
      buildLocalCleanupEntries() {
        return [];
      },
      async enqueueInTransaction() {
        return [];
      },
      async processPending() {
        return { examined: 0, deleted: 0, missing: 0, failed: 0, pendingIds: [] };
      },
    },
  };

  return require(servicePath);
}

test('addVideo: pg transaction requests insertId through RETURNING id and uses it for video_meta', async () => {
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
            return [{ insertId: /RETURNING\s+id/i.test(statement) ? 91 : 0, affectedRows: 1 }, []];
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

  const result = await service.addVideo(3, 'a.mp4', 'video/mp4', 1024, {
    poster: 'a.jpg',
    duration: 10,
    width: 1920,
    height: 1080,
    bitrate: 800,
    format: 'mp4',
  });

  assert.equal(result.insertId, 91);
  const firstExecute = calls.find((call) => call.type === 'execute');
  assert.match(firstExecute.statement, /INSERT INTO file \(user_id, filename, mimetype, size, file_type\) VALUES \(\?,\?,\?,\?,'video'\) RETURNING id;/i);
  assert.deepEqual(firstExecute.params, [3, 'a.mp4', 'video/mp4', 1024]);

  const secondExecute = calls.filter((call) => call.type === 'execute')[1];
  assert.match(secondExecute.statement, /INSERT INTO video_meta/i);
  assert.deepEqual(secondExecute.params, [91, 'a.jpg', 10, 1920, 1080, 800, 'mp4']);
});

test('updateVideoPoster: pg uses update-from SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ affectedRows: 1 }, []];
    },
  });

  await service.updateVideoPoster(7, 'poster.jpg');

  assert.match(calls[0].statement, /UPDATE video_meta AS vm/i);
  assert.match(calls[0].statement, /SET poster = \?/i);
  assert.match(calls[0].statement, /FROM file AS f/i);
  assert.doesNotMatch(calls[0].statement, /INNER JOIN/i);
  assert.deepEqual(calls[0].params, ['poster.jpg', 7]);
});

test('updateVideoMetadata: pg uses update-from SQL and unqualified SET clauses', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ affectedRows: 1 }, []];
    },
  });

  await service.updateVideoMetadata(7, {
    duration: 12,
    width: 640,
    format: 'mp4',
  });

  assert.match(calls[0].statement, /UPDATE video_meta AS vm/i);
  assert.match(calls[0].statement, /SET duration = \?, width = \?, format = \?/i);
  assert.match(calls[0].statement, /FROM file AS f/i);
  assert.doesNotMatch(calls[0].statement, /INNER JOIN/i);
  assert.doesNotMatch(calls[0].statement, /vm\.duration\s*=/i);
  assert.deepEqual(calls[0].params, [12, 640, 'mp4', 7]);
});

test('updateTranscodeStatus: pg uses update-from SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ affectedRows: 1 }, []];
    },
  });

  await service.updateTranscodeStatus(7, 'completed');

  assert.match(calls[0].statement, /UPDATE video_meta AS vm/i);
  assert.match(calls[0].statement, /SET transcode_status = \?/i);
  assert.match(calls[0].statement, /FROM file AS f/i);
  assert.doesNotMatch(calls[0].statement, /INNER JOIN/i);
  assert.deepEqual(calls[0].params, ['completed', 7]);
});

test('updateVideoArticle: publishing videos also clears draft_id for newly linked files', async () => {
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
          if (/FROM article/i.test(statement)) return [[{ id: 201 }], []];
          if (/SELECT id FROM file WHERE article_id = \? AND file_type = 'video'/i.test(statement)) {
            return [[{ id: 31 }, { id: 32 }], []];
          }
          if (/SELECT id[\s\S]+id = ANY/i.test(statement)) return [[{ id: 32 }, { id: 33 }], []];
          if (/SET article_id = \?,\s*draft_id = NULL/i.test(statement)) return [{ affectedRows: 2 }, []];
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
  service.promotePublishedVideoIds = async () => ({ attempted: 0, ready: 0, inProgress: 0, failed: 0, completed: 0 });

  console.log = () => {};

  try {
    const result = await service.updateVideoArticle(201, [32, 33], 9);

    assert.deepEqual(result, {
      success: true,
      affectedRows: 2,
      deletedCount: 1,
    });

    const executeCalls = calls.filter((call) => call.type === 'execute');
    const bindVideosExecute = executeCalls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
    assert.ok(bindVideosExecute, 'Expected video binding SQL to clear draft_id');
    assert.deepEqual(bindVideosExecute.params, [201, [32, 33], 9, 201]);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('updateVideoArticle: empty videoIds still clears old article video links without rebinding', async () => {
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
          if (/FROM article/i.test(statement)) return [[{ id: 201 }], []];
          if (/SELECT id FROM file WHERE article_id = \? AND file_type = 'video'/i.test(statement)) {
            return [[{ id: 31 }, { id: 32 }], []];
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
    const result = await service.updateVideoArticle(201, [], 9);

    assert.deepEqual(result, {
      success: true,
      affectedRows: 0,
      deletedCount: 2,
    });

    const executeCalls = calls.filter((call) => call.type === 'execute');
    const clearArticleExecute = executeCalls.find((call) => /UPDATE file SET article_id = NULL/i.test(call.statement));
    assert.ok(clearArticleExecute, 'Expected video clearing SQL to run');
    assert.deepEqual(clearArticleExecute.params, [201]);

    const bindVideosExecute = executeCalls.find((call) => /SET article_id = \?,\s*draft_id = NULL/i.test(call.statement));
    assert.equal(bindVideosExecute, undefined);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('updateVideoArticle: commits completed video association before starting video and poster promotion', async () => {
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
          if (/FROM article/i.test(statement)) return [[{ id: 201 }], []];
          if (/SELECT id FROM file WHERE article_id = \? AND file_type = 'video'/i.test(statement)) {
            return [[], []];
          }
          if (/SELECT id[\s\S]+id = ANY/i.test(statement)) return [[{ id: 33 }], []];
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
  service.promotePublishedVideoIds = async (videoIds, articleId) => {
    calls.push({ type: 'promote', videoIds, articleId });
    return { attempted: 2, ready: 2, inProgress: 0, failed: 0, completed: 1 };
  };

  console.log = () => {};
  try {
    const result = await service.updateVideoArticle(201, [33], 9);
    const commitIndex = calls.findIndex((call) => call.type === 'commit');
    const promoteIndex = calls.findIndex((call) => call.type === 'promote');
    assert.ok(commitIndex >= 0);
    assert.ok(promoteIndex > commitIndex);
    assert.deepEqual(calls[promoteIndex], { type: 'promote', videoIds: [33], articleId: 201 });
    assert.deepEqual(result, { success: true, affectedRows: 1, deletedCount: 0 });
  } finally {
    console.log = originalConsoleLog;
  }
});

test('updateVideoArticle: promotion failure preserves the committed local association', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement) {
          if (/FROM article/i.test(statement)) return [[{ id: 201 }], []];
          if (/SELECT id FROM file WHERE article_id/i.test(statement)) return [[], []];
          if (/SELECT id[\s\S]+id = ANY/i.test(statement)) return [[{ id: 33 }], []];
          return [{ affectedRows: 1 }, []];
        },
        async commit() {
          calls.push('commit');
        },
        async rollback() {
          calls.push('rollback');
        },
        release() {},
      };
    },
  });
  service.promotePublishedVideoIds = async () => {
    calls.push('promote');
    throw new Error('R2 unavailable');
  };

  console.log = () => {};
  console.error = () => {};
  try {
    const result = await service.updateVideoArticle(201, [33], 9);
    assert.deepEqual(result, { success: true, affectedRows: 1, deletedCount: 0 });
    assert.deepEqual(calls, ['commit', 'promote']);
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
});

test('updateVideoArticle: invokes the live lock-and-revalidate promotion path after commit', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement) {
          calls.push({ type: 'transactionExecute', statement });
          if (/FROM article/i.test(statement)) return [[{ id: 201 }], []];
          if (/SELECT id FROM file WHERE article_id/i.test(statement)) return [[], []];
          if (/SELECT id[\s\S]+id = ANY/i.test(statement)) return [[{ id: 33 }], []];
          return [{ affectedRows: 1 }, []];
        },
        async commit() {
          calls.push({ type: 'commit' });
        },
        async rollback() {},
        release() {},
      };
    },
  });
  service.promotePublishedVideoIds = async (videoIds, articleId) => {
    calls.push({ type: 'livePromote', videoIds, articleId });
    return { attempted: 2, ready: 2, inProgress: 0, failed: 0, completed: 1 };
  };

  console.log = () => {};
  try {
    await service.updateVideoArticle(201, [33], 9);
  } finally {
    console.log = originalConsoleLog;
  }

  const commitIndex = calls.findIndex((call) => call.type === 'commit');
  const livePromoteIndex = calls.findIndex((call) => call.type === 'livePromote');
  assert.ok(livePromoteIndex > commitIndex);
  assert.deepEqual(calls[livePromoteIndex], { type: 'livePromote', videoIds: [33], articleId: 201 });
});

test('updateVideoArticle: refuses to mutate an article not owned by the authenticated user', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (/FROM article/i.test(statement)) return [[], []];
          return [{ affectedRows: 1 }, []];
        },
        async commit() {
          calls.push({ type: 'commit' });
        },
        async rollback() {
          calls.push({ type: 'rollback' });
        },
        release() {},
      };
    },
  });

  await assert.rejects(service.updateVideoArticle(201, [33], 9), /无权关联视频|文章不存在/);
  assert.equal(
    calls.some((call) => call.type === 'execute' && /UPDATE file/i.test(call.statement)),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'rollback'),
    true,
  );
  const ownershipRead = calls.find((call) => call.type === 'execute' && /FROM article/i.test(call.statement));
  assert.deepEqual(ownershipRead.params, [201, 9]);
});

test('promotePublishedVideoIds: holds a non-key file lock and revalidates live article/status through upload', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'begin' });
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            return [[{ id: 33, article_id: 201, filename: 'clip.mp4', mimetype: 'video/mp4', poster: 'clip-poster.jpg', transcode_status: 'completed' }], []];
          },
          async commit() {
            calls.push({ type: 'commit' });
          },
          async rollback() {
            calls.push({ type: 'rollback' });
          },
          release() {},
        };
      },
    },
    {
      async promotePublishedVideos(payload) {
        calls.push({ type: 'promote', payload });
        return { attempted: 2, ready: 2, inProgress: 0, failed: 0, completed: 1 };
      },
    },
  );

  await service.promotePublishedVideoIds([33]);

  const read = calls.find((call) => call.type === 'execute');
  assert.match(read.statement, /f\.article_id IS NOT NULL/i);
  assert.match(read.statement, /vm\.transcode_status = 'completed'/i);
  assert.match(read.statement, /FOR NO KEY UPDATE OF f/i);
  assert.deepEqual(read.params, [[33]]);
  const promoteIndex = calls.findIndex((call) => call.type === 'promote');
  const commitIndex = calls.findIndex((call) => call.type === 'commit');
  assert.ok(promoteIndex >= 0 && commitIndex > promoteIndex);
  assert.equal(calls[promoteIndex].payload.articleId, 201);
});

test('deleteVideos: locks owned rows and deletes R2 video/poster before database rows', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'begin' });
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            if (/SELECT\s+f\.id,[\s\S]+FOR UPDATE OF f/i.test(statement)) {
              return [[{ id: 71, filename: 'clip.mp4', user_id: 5, poster: 'clip-poster.jpg' }], []];
            }
            if (/DELETE FROM file/i.test(statement)) return [{ affectedRows: 1 }, []];
            return [[], []];
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
        return { staged: 2, deleted: 2 };
      },
    },
    {
      buildLocalCleanupEntries(rows) {
        return [
          { storageArea: 'video', filename: rows[0].filename },
          { storageArea: 'video', filename: rows[0].poster },
        ];
      },
      async enqueueInTransaction(conn, entries) {
        calls.push({ type: 'enqueueLocal', entries });
        return [801, 802];
      },
      async processPending(options) {
        calls.push({ type: 'processLocal', options });
        return { examined: 2, deleted: 2, missing: 0, failed: 0, pendingIds: [] };
      },
    },
  );

  const result = await service.deleteVideos([71], 5);

  assert.deepEqual(result.videosToDelete, [{ id: 71, filename: 'clip.mp4', user_id: 5, poster: 'clip-poster.jpg' }]);
  const selectCall = calls.find((call) => call.type === 'execute' && /SELECT\s+f\.id/i.test(call.statement));
  assert.match(selectCall.statement, /FOR UPDATE OF f/i);
  const r2Index = calls.findIndex((call) => call.type === 'deleteR2');
  const deleteIndex = calls.findIndex((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement));
  assert.ok(r2Index >= 0);
  assert.ok(deleteIndex > r2Index);
  assert.deepEqual(calls[r2Index].fileIds, [71]);
  const enqueueIndex = calls.findIndex((call) => call.type === 'enqueueLocal');
  const commitIndex = calls.findIndex((call) => call.type === 'commit');
  const processIndex = calls.findIndex((call) => call.type === 'processLocal');
  assert.ok(enqueueIndex > r2Index && deleteIndex > enqueueIndex);
  assert.ok(processIndex > commitIndex);
  assert.deepEqual(calls[processIndex].options, { ids: [801, 802] });
});

test('deleteVideos: pending promotion aborts deletion and preserves database rows', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {},
          async execute(statement) {
            calls.push({ type: 'execute', statement });
            if (/SELECT\s+f\.id/i.test(statement)) {
              return [[{ id: 71, filename: 'clip.mp4', user_id: 5, poster: 'clip-poster.jpg' }], []];
            }
            return [{ affectedRows: 1 }, []];
          },
          async commit() {
            calls.push({ type: 'commit' });
          },
          async rollback() {
            calls.push({ type: 'rollback' });
          },
          release() {},
        };
      },
    },
    {
      async deleteR2ObjectsForFiles() {
        throw new Error('R2 upload is still pending');
      },
    },
  );

  await assert.rejects(service.deleteVideos([71], 5), /still pending/);

  assert.equal(
    calls.some((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement)),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'rollback'),
    true,
  );
  assert.equal(
    calls.some((call) => call.type === 'commit'),
    false,
  );
});

test('deleteVideos: active FFmpeg processing is not deleted underneath the background pipeline', async () => {
  const calls = [];
  const service = loadServiceWithConnection(
    {
      async getConnection() {
        return {
          async beginTransaction() {},
          async execute(statement) {
            calls.push({ type: 'execute', statement });
            if (/SELECT\s+f\.id/i.test(statement)) {
              return [
                [
                  {
                    id: 71,
                    filename: 'clip.mp4',
                    user_id: 5,
                    poster: null,
                    transcode_status: 'processing',
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
          release() {},
        };
      },
    },
    {
      async deleteR2ObjectsForFiles() {
        calls.push({ type: 'deleteR2' });
      },
    },
  );

  await assert.rejects(service.deleteVideos([71], 5), /视频仍在处理/);

  assert.equal(
    calls.some((call) => call.type === 'deleteR2'),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'execute' && /DELETE FROM file/i.test(call.statement)),
    false,
  );
  assert.equal(
    calls.some((call) => call.type === 'rollback'),
    true,
  );
});
