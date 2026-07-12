const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const routerPath = path.resolve(__dirname, '../../src/router/tag.router.js');
const controllerPath = path.resolve(__dirname, '../../src/controller/tag.controller.js');
const authPath = path.resolve(__dirname, '../../src/middleware/auth.middleware.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadRouter() {
  delete require.cache[routerPath];
  delete require.cache[controllerPath];
  delete require.cache[authPath];

  injectCache(controllerPath, {
    addTag: async () => {},
    getList: async () => {},
    getUserOrder: async () => {},
    replaceUserOrder: async () => {},
  });
  injectCache(authPath, {
    verifyAuth: async (_ctx, next) => next(),
  });

  return require(routerPath);
}

test('tagRouter: keeps the public list and protects personal order routes', () => {
  const router = loadRouter();
  const routes = router.stack.map((layer) => ({ path: layer.path, methods: layer.methods, middlewareCount: layer.stack.length }));

  assert.deepEqual(routes, [
    { path: '/tag', methods: ['POST'], middlewareCount: 2 },
    { path: '/tag/order', methods: ['HEAD', 'GET'], middlewareCount: 2 },
    { path: '/tag/order', methods: ['PUT'], middlewareCount: 2 },
    { path: '/tag', methods: ['HEAD', 'GET'], middlewareCount: 1 },
  ]);
});
