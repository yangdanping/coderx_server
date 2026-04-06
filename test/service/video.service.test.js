const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/video.service.js');
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
