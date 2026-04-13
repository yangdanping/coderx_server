const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/image.controller.js');
const imageServicePath = path.resolve(__dirname, '../../src/service/image.service.js');
const deleteFilePath = path.resolve(__dirname, '../../src/utils/deleteFile.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithMocks({ imageService }) {
  delete require.cache[controllerPath];
  delete require.cache[imageServicePath];
  delete require.cache[deleteFilePath];

  injectCache(imageServicePath, imageService);
  injectCache(deleteFilePath, () => {});

  return require(controllerPath);
}

test('updateFile: empty uploaded array clears article image links instead of failing validation', async () => {
  const calls = [];
  const imageService = {
    async updateImageArticle(articleId, imageIds, coverImageId) {
      calls.push({ articleId, imageIds, coverImageId });
      return { success: true, affectedRows: 0, deletedCount: 2, coverSet: false };
    },
  };

  const controller = loadControllerWithMocks({ imageService });
  const ctx = {
    params: { articleId: '15' },
    request: {
      body: {
        uploaded: [],
      },
    },
  };

  await controller.updateFile(ctx, async () => {});

  assert.deepEqual(calls, [{ articleId: '15', imageIds: [], coverImageId: null }]);
  assert.equal(ctx.body.code, 0);
  assert.deepEqual(ctx.body.data, {
    success: true,
    affectedRows: 0,
    deletedCount: 2,
    coverSet: false,
  });
});
