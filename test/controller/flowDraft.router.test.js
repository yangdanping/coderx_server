const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const routerPath = path.resolve(__dirname, '../../src/router/flowDraft.router.js');
const controllerPath = path.resolve(__dirname, '../../src/controller/flowDraft.controller.js');
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
    saveFlowDraft: async () => {},
    getFlowDraft: async () => {},
    deleteFlowDraft: async () => {},
  });
  injectCache(authPath, {
    verifyAuth: async (ctx, next) => next(),
  });

  return require(routerPath);
}

test('flowDraftRouter: registers authenticated PUT/GET/DELETE routes under /flow/draft', () => {
  const router = loadRouterWithMocks();
  const routes = router.stack.map((layer) => ({
    path: layer.path,
    methods: layer.methods,
    middlewareCount: layer.stack.length,
  }));

  assert.equal(router.opts.prefix, '/flow/draft');
  assert.deepEqual(routes, [
    { path: '/flow/draft', methods: ['PUT'], middlewareCount: 2 },
    { path: '/flow/draft', methods: ['HEAD', 'GET'], middlewareCount: 2 },
    { path: '/flow/draft/:draftId', methods: ['DELETE'], middlewareCount: 2 },
  ]);
});
