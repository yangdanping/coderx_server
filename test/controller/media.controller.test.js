const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/media.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/mediaImage.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

function loadController(service) {
  delete require.cache[controllerPath];
  delete require.cache[servicePath];
  injectCache(servicePath, service);
  return require(controllerPath);
}

test('uploadImage forwards the authenticated user and memory file, then returns the asset', async () => {
  const calls = [];
  const asset = { id: 73, url: '/original', thumbnailUrl: '/small', mimeType: 'image/webp', sizeBytes: 12, width: 10, height: 8 };
  const controller = loadController({
    async createPendingImage(userId, file) {
      calls.push({ userId, file });
      return asset;
    },
  });
  const file = { buffer: Buffer.from('image'), mimetype: 'image/png' };
  const ctx = { user: { id: 9 }, file };

  await controller.uploadImage(ctx);

  assert.deepEqual(calls, [{ userId: 9, file }]);
  assert.deepEqual(ctx.body, { code: 0, data: asset });
});

test('deleteImage forwards ctx.user.id and a normalized media ID', async () => {
  const calls = [];
  const controller = loadController({
    async deletePendingImage(userId, mediaId) {
      calls.push({ userId, mediaId });
      return { deleted: true };
    },
  });
  const ctx = { user: { id: 9 }, params: { mediaId: '73' } };

  await controller.deleteImage(ctx);

  assert.deepEqual(calls, [{ userId: 9, mediaId: 73 }]);
  assert.deepEqual(ctx.body, { code: 0, data: { deleted: true } });
});

test('media image middleware uses memory storage, one image field, the byte limit, and exact MIME allowlist', () => {
  const multerPath = require.resolve('@koa/multer');
  const middlewarePath = path.resolve(__dirname, '../../src/middleware/mediaImage.middleware.js');
  const originalMulter = require.cache[multerPath];
  const calls = [];
  function multer(options) {
    calls.push({ type: 'options', options });
    return {
      single(field) {
        calls.push({ type: 'single', field });
        return async () => {};
      },
    };
  }
  multer.memoryStorage = () => ({ kind: 'memory' });

  try {
    delete require.cache[middlewarePath];
    injectCache(multerPath, multer);
    require(middlewarePath);
  } finally {
    delete require.cache[middlewarePath];
    if (originalMulter) require.cache[multerPath] = originalMulter;
    else delete require.cache[multerPath];
  }

  assert.deepEqual(calls[0].options.storage, { kind: 'memory' });
  assert.equal(calls[0].options.limits.fileSize, 10 * 1024 * 1024);
  assert.deepEqual(calls[1], { type: 'single', field: 'image' });

  for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
    let result;
    calls[0].options.fileFilter({}, { mimetype }, (error, accepted) => { result = { error, accepted }; });
    assert.deepEqual(result, { error: null, accepted: true });
  }
  let rejected;
  calls[0].options.fileFilter({}, { mimetype: 'image/svg+xml' }, (error, accepted) => { rejected = { error, accepted }; });
  assert.match(rejected.error.message, /JPEG、PNG 或 WebP/);
  assert.equal(rejected.accepted, undefined);
});

test('media image middleware maps Multer LIMIT_FILE_SIZE to an exact exposed 400 error', async () => {
  const multerPath = require.resolve('@koa/multer');
  const middlewarePath = path.resolve(__dirname, '../../src/middleware/mediaImage.middleware.js');
  const originalMulter = require.cache[multerPath];
  const limitError = Object.assign(new Error('File too large'), {
    code: 'LIMIT_FILE_SIZE',
    field: 'image',
  });
  function multer() {
    return {
      single() {
        return async () => {
          throw limitError;
        };
      },
    };
  }
  multer.memoryStorage = () => ({ kind: 'memory' });

  try {
    delete require.cache[middlewarePath];
    injectCache(multerPath, multer);
    const middleware = require(middlewarePath);

    await assert.rejects(
      () => middleware({ path: '/media/images' }, async () => {}),
      (error) => {
        assert.equal(error.name, 'BusinessError');
        assert.equal(error.httpStatus, 400);
        assert.equal(error.expose, true);
        assert.equal(error.message, '图片大小不能超过 10MB');
        return true;
      },
    );
  } finally {
    delete require.cache[middlewarePath];
    if (originalMulter) require.cache[multerPath] = originalMulter;
    else delete require.cache[multerPath];
  }
});

test('media router protects POST and DELETE with maintenance then authentication', () => {
  const routerPath = path.resolve(__dirname, '../../src/router/media.router.js');
  const authPath = path.resolve(__dirname, '../../src/middleware/auth.middleware.js');
  const maintenancePath = path.resolve(__dirname, '../../src/middleware/mediaMaintenance.middleware.js');
  const middlewarePath = path.resolve(__dirname, '../../src/middleware/mediaImage.middleware.js');
  const verifyAuth = async () => {};
  const maintenance = async () => {};
  const upload = async () => {};
  const uploadImage = async () => {};
  const deleteImage = async () => {};

  for (const modulePath of [routerPath, controllerPath, authPath, maintenancePath, middlewarePath]) delete require.cache[modulePath];
  injectCache(controllerPath, { uploadImage, deleteImage });
  injectCache(authPath, { verifyAuth });
  injectCache(maintenancePath, maintenance);
  injectCache(middlewarePath, upload);

  const router = require(routerPath);
  const post = router.stack.find((layer) => layer.methods.includes('POST'));
  const del = router.stack.find((layer) => layer.methods.includes('DELETE'));

  assert.equal(router.opts.prefix, '/media/images');
  assert.equal(post.path, '/media/images');
  assert.deepEqual(post.stack, [maintenance, verifyAuth, upload, uploadImage]);
  assert.equal(del.path, '/media/images/:mediaId');
  assert.deepEqual(del.stack, [maintenance, verifyAuth, deleteImage]);
});
