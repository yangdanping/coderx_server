const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createMediaUrlService } = require('@/service/mediaUrl.service');

function createService({ readMode, objects = [] }) {
  const calls = [];
  return {
    calls,
    service: createMediaUrlService({
      readMode,
      mediaObjectService: {
        async findReadyR2Objects(fileId) {
          calls.push({ type: 'find', fileId });
          return objects;
        },
      },
      r2Store: {
        publicUrl(key) {
          calls.push({ type: 'r2Url', key });
          return `https://media.example/${key}`;
        },
      },
      localUrlResolver(fileId, variant) {
        calls.push({ type: 'localUrl', fileId, variant });
        return `https://api.example/local/${fileId}/${variant}`;
      },
    }),
  };
}

test('mediaUrlService: local mode always returns the current local resolver URL', async () => {
  const { calls, service } = createService({
    readMode: 'local',
    objects: [{ status: 'ready', variant: 'original', objectKey: 'r2-key' }],
  });

  assert.equal(await service.resolveImageUrl(512, { variant: 'small' }), 'https://api.example/local/512/small');
  assert.deepEqual(calls, [{ type: 'localUrl', fileId: 512, variant: 'small' }]);
});

test('mediaUrlService: r2_preferred returns only matching ready R2 objects', async () => {
  const { service } = createService({
    readMode: 'r2_preferred',
    objects: [
      { status: 'failed', variant: 'original', objectKey: 'failed-key' },
      { status: 'pending', variant: 'original', objectKey: 'pending-key' },
      { status: 'ready', variant: 'original', objectKey: 'ready-key' },
    ],
  });

  assert.equal(await service.resolveImageUrl(512), 'https://media.example/ready-key');
});

test('mediaUrlService: small image requests fall back to ready R2 original', async () => {
  const { service } = createService({
    readMode: 'r2_preferred',
    objects: [{ status: 'ready', variant: 'original', objectKey: 'original-key' }],
  });

  assert.equal(await service.resolveImageUrl(512, { variant: 'small' }), 'https://media.example/original-key');
});

test('mediaUrlService: ignores non-ready R2 rows and falls back to local URLs', async () => {
  const { service } = createService({
    readMode: 'r2_preferred',
    objects: [
      { status: 'failed', variant: 'video', objectKey: 'failed-video' },
      { status: 'deleting', variant: 'poster', objectKey: 'deleting-poster' },
    ],
  });

  assert.equal(await service.resolveVideoUrl(640), 'https://api.example/local/640/video');
  assert.equal(await service.resolveVideoPosterUrl(640), 'https://api.example/local/640/poster');
});
