const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const routerPath = path.resolve(__dirname, '../../src/router/draft.router.js');
const controllerPath = path.resolve(__dirname, '../../src/controller/draft.controller.js');
const authPath = path.resolve(__dirname, '../../src/middleware/auth.middleware.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadRouterWithMocks() {
  delete require.cache[routerPath];
  delete require.cache[controllerPath];
  delete require.cache[authPath];

  injectCache(controllerPath, {
    saveDraft: async () => {},
    getDraft: async () => {},
    getDraftByArticleId: async () => {},
    deleteDraft: async () => {},
  });

  injectCache(authPath, {
    verifyAuth: async (ctx, next) => next(),
  });

  return require(routerPath);
}

test('draftRouter: registers PUT/GET/DELETE routes under /draft prefix', () => {
  const router = loadRouterWithMocks();
  const routes = router.stack.map((layer) => ({
    path: layer.path,
    methods: layer.methods,
  }));

  assert.equal(router.opts.prefix, '/draft');
  assert.deepEqual(routes, [
    { path: '/draft', methods: ['PUT'] },
    { path: '/draft', methods: ['HEAD', 'GET'] },
    { path: '/draft/:articleId', methods: ['HEAD', 'GET'] },
    { path: '/draft/:draftId', methods: ['DELETE'] },
  ]);
});
