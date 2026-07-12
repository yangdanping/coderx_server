const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const Result = require('@/app/Result');
const controllerPath = path.resolve(__dirname, '../../src/controller/tag.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/tag.service.js');

function loadController(service) {
  delete require.cache[controllerPath];
  delete require.cache[servicePath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: service,
  };
  return require(controllerPath);
}

test('getUserOrder: scopes the read to the authenticated user', async () => {
  const calls = [];
  const orderedTags = [{ id: 3, name: 'JS/TS' }];
  const controller = loadController({
    async getUserTagOrder(userId) {
      calls.push(userId);
      return orderedTags;
    },
  });
  const ctx = { user: { id: 7 } };

  await controller.getUserOrder(ctx);

  assert.deepEqual(calls, [7]);
  assert.deepEqual(ctx.body, Result.success(orderedTags));
});

test('replaceUserOrder: forwards authenticated user and submitted tag ids', async () => {
  const calls = [];
  const orderedTags = [
    { id: 3, name: 'JS/TS' },
    { id: 1, name: '前端' },
  ];
  const controller = loadController({
    async replaceUserTagOrder(userId, tagIds) {
      calls.push({ userId, tagIds });
      return orderedTags;
    },
  });
  const ctx = {
    user: { id: 7 },
    request: { body: { tagIds: [3, 1] } },
  };

  await controller.replaceUserOrder(ctx);

  assert.deepEqual(calls, [{ userId: 7, tagIds: [3, 1] }]);
  assert.deepEqual(ctx.body, Result.success(orderedTags));
});
