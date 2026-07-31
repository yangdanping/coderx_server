const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/image.controller.js');
const imageServicePath = path.resolve(__dirname, '../../src/service/image.service.js');
const deleteFilePath = path.resolve(__dirname, '../../src/utils/deleteFile.js');
const mediaRuntimePath = path.resolve(__dirname, '../../src/service/mediaRuntime.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithMocks({ imageService, deleteFile = () => {}, mediaRuntime = {} }) {
  delete require.cache[controllerPath];
  delete require.cache[imageServicePath];
  delete require.cache[deleteFilePath];
  delete require.cache[mediaRuntimePath];

  injectCache(imageServicePath, imageService);
  injectCache(deleteFilePath, deleteFile);
  injectCache(mediaRuntimePath, mediaRuntime);

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

test('deleteFile: removes staged R2 objects before database rows and local variants', async () => {
  const calls = [];
  const imageService = {
    async findImagesByIds(imageIds) {
      calls.push({ type: 'find', imageIds });
      return [{ id: 41, filename: 'cover.jpg' }];
    },
    async deleteImages(imageIds) {
      calls.push({ type: 'deleteRows', imageIds });
      return { affectedRows: 1 };
    },
  };
  const controller = loadControllerWithMocks({
    imageService,
    mediaRuntime: {
      async deleteR2ObjectsForFiles(fileIds) {
        calls.push({ type: 'deleteR2', fileIds });
        return { staged: 2, deleted: 2 };
      },
    },
    deleteFile(files) {
      calls.push({ type: 'deleteLocal', files });
    },
  });
  const ctx = {
    request: {
      body: {
        uploaded: [{ id: 41 }],
      },
    },
  };

  await controller.deleteFile(ctx, async () => {});

  assert.deepEqual(calls, [
    { type: 'find', imageIds: [41] },
    { type: 'deleteR2', fileIds: [41] },
    { type: 'deleteRows', imageIds: [41] },
    { type: 'deleteLocal', files: [{ id: 41, filename: 'cover.jpg' }] },
  ]);
  assert.equal(ctx.body.code, 0);
});
