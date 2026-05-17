const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const Result = require('@/app/Result');

const controllerPath = path.resolve(__dirname, '../../src/controller/notification.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/notification.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadController(notificationService) {
  delete require.cache[controllerPath];
  delete require.cache[servicePath];
  injectCache(servicePath, notificationService);
  return require(controllerPath);
}

test('notification controller: list uses current user and pagination query', async () => {
  const calls = [];
  const controller = loadController({
    async getNotificationList(recipientId, pagination) {
      calls.push({ recipientId, pagination });
      return [{ id: 1, recipientId }];
    },
  });
  const ctx = {
    user: { id: 7 },
    query: { offset: '20', limit: '5' },
  };

  await controller.list(ctx);

  assert.deepEqual(calls, [{ recipientId: 7, pagination: { offset: '20', limit: '5' } }]);
  assert.deepEqual(ctx.body, Result.success([{ id: 1, recipientId: 7 }]));
});

test('notification controller: unread count returns recipient-scoped count', async () => {
  const controller = loadController({
    async getUnreadCount(recipientId) {
      assert.equal(recipientId, 7);
      return 3;
    },
  });
  const ctx = { user: { id: 7 } };

  await controller.unreadCount(ctx);

  assert.deepEqual(ctx.body, Result.success({ count: 3 }));
});

test('notification controller: mark one and all read scope writes to current user', async () => {
  const calls = [];
  const controller = loadController({
    async markAsRead(notificationId, recipientId) {
      calls.push({ method: 'markAsRead', notificationId, recipientId });
      return { affectedRows: 1 };
    },
    async markAllAsRead(recipientId) {
      calls.push({ method: 'markAllAsRead', recipientId });
      return { affectedRows: 2 };
    },
  });
  const oneCtx = { user: { id: 7 }, params: { notificationId: '99' } };
  const allCtx = { user: { id: 7 }, params: {} };

  await controller.markRead(oneCtx);
  await controller.markAllRead(allCtx);

  assert.deepEqual(calls, [
    { method: 'markAsRead', notificationId: '99', recipientId: 7 },
    { method: 'markAllAsRead', recipientId: 7 },
  ]);
  assert.deepEqual(oneCtx.body, Result.success({ affectedRows: 1 }));
  assert.deepEqual(allCtx.body, Result.success({ affectedRows: 2 }));
});
