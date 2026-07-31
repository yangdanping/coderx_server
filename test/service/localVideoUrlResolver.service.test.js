const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

let createLocalVideoUrlResolver;
try {
  ({ createLocalVideoUrlResolver } = require('@/service/localVideoUrlResolver.service'));
} catch {
  createLocalVideoUrlResolver = undefined;
}

test('local video URL resolver returns the final video and database poster URLs', async () => {
  assert.equal(typeof createLocalVideoUrlResolver, 'function');
  const calls = [];
  const resolver = createLocalVideoUrlResolver({
    publicApiOrigin: 'https://api.example',
    database: {
      async execute(statement, params) {
        calls.push({ statement, params });
        return [
          [
            {
              id: 640,
              filename: 'clip.mp4',
              poster: 'clip-poster.jpg',
              file_type: 'video',
            },
          ],
          [],
        ];
      },
    },
  });

  assert.equal(await resolver(640, 'video'), 'https://api.example/article/video/clip.mp4');
  assert.equal(await resolver(640, 'poster'), 'https://api.example/article/video/clip-poster.jpg');
  assert.deepEqual(
    calls.map((call) => call.params),
    [[640], [640]],
  );
});

test('local video URL resolver keeps poster null until FFmpeg has written it to the database', async () => {
  assert.equal(typeof createLocalVideoUrlResolver, 'function');
  const resolver = createLocalVideoUrlResolver({
    publicApiOrigin: 'https://api.example',
    database: {
      async execute() {
        return [[{ id: 641, filename: 'processing.mp4', poster: null, file_type: 'video' }], []];
      },
    },
  });

  assert.equal(await resolver(641, 'video'), 'https://api.example/article/video/processing.mp4');
  assert.equal(await resolver(641, 'poster'), null);
});
