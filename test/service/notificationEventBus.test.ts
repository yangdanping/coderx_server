import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_NEW_EVENT,
  buildNotificationChannel,
  createNotificationEventBus,
} from '../../src/socket/notification/notificationEventBus.js';

test('notificationEventBus: publishes notification:new payload to configured Redis channel', async () => {
  const calls = [];
  const bus = createNotificationEventBus({
    keyPrefix: 'coderx-test',
    publisherClient: {
      async publish(channel, message) {
        calls.push({ channel, message });
        return 1;
      },
    },
  });
  const notification = { id: 88, recipientId: 10, actorId: 20, articleId: 30 };

  await bus.publishNotificationCreated(notification);

  assert.equal(calls[0].channel, 'coderx-test:notification:new');
  assert.deepEqual(JSON.parse(calls[0].message), {
    event: NOTIFICATION_NEW_EVENT,
    notification,
  });
});

test('notificationEventBus: subscribes and parses notification payloads from Redis', async () => {
  const calls = [];
  let handler;
  const subscriberClient = {
    async subscribe(channel, callback) {
      calls.push(['subscribe', channel]);
      handler = callback;
    },
    async unsubscribe(channel) {
      calls.push(['unsubscribe', channel]);
    },
  };
  const received = [];
  const bus = createNotificationEventBus({
    channel: buildNotificationChannel('custom'),
    subscriberClient,
  });

  const cleanup = await bus.subscribeNotificationEvents((payload, channel) => {
    received.push({ payload, channel });
  });
  await handler(JSON.stringify({ event: NOTIFICATION_NEW_EVENT, notification: { id: 1, recipientId: 2 } }), 'custom:notification:new');
  await cleanup();

  assert.deepEqual(calls, [
    ['subscribe', 'custom:notification:new'],
    ['unsubscribe', 'custom:notification:new'],
  ]);
  assert.deepEqual(received, [
    {
      payload: { event: NOTIFICATION_NEW_EVENT, notification: { id: 1, recipientId: 2 } },
      channel: 'custom:notification:new',
    },
  ]);
});

test('notificationEventBus: ignores malformed messages and logs the parse failure', async () => {
  let handler;
  const errors = [];
  const bus = createNotificationEventBus({
    subscriberClient: {
      async subscribe(_channel, callback) {
        handler = callback;
      },
    },
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
  });

  await bus.subscribeNotificationEvents(() => {
    throw new Error('should not call handler');
  });
  await handler('{not-json', 'coderx:notification:new');

  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /通知事件解析失败/);
});

test('notificationEventBus: uses one owned connection for subscriptions and closes it once', async () => {
  const clients = [];
  const bus = createNotificationEventBus({
    keyPrefix: 'coderx-test-only',
    redis: {
      createClient() {
        const client = {
          isOpen: false,
          on() {},
          async connect() { this.isOpen = true; },
          async subscribe() {},
          async unsubscribe() {},
          destroy() { this.isOpen = false; this.destroys = (this.destroys || 0) + 1; },
        };
        clients.push(client);
        return client;
      },
    },
  });

  await bus.subscribeNotificationEvents(() => {});
  await Promise.all([bus.close(), bus.close()]);

  assert.equal(clients.length, 1);
  assert.equal(clients[0].destroys, 1);
});

test('notificationEventBus: test namespace publishes independently of other namespaces on Redis', async () => {
  const subscribers = new Map();
  const subscriberClient = {
    async subscribe(channel, listener) { subscribers.set(channel, listener); },
    async unsubscribe(channel) { subscribers.delete(channel); },
  };
  const publisherClient = {
    async publish(channel, payload) {
      await subscribers.get(channel)?.(payload, channel);
      return Number(subscribers.has(channel));
    },
  };
  const normalBus = createNotificationEventBus({ keyPrefix: 'comparison-only', subscriberClient });
  const testBus = createNotificationEventBus({ keyPrefix: 'coderx-test-only', publisherClient, subscriberClient });
  const received = [];
  const removeNormal = await normalBus.subscribeNotificationEvents(() => assert.fail('Other namespace received notification'));
  const removeTest = await testBus.subscribeNotificationEvents(payload => received.push(payload));
  const notification = { id: 88, recipientId: 10 };

  try {
    assert.equal(await testBus.publishNotificationCreated(notification), 1);
    assert.deepEqual(received, [{ event: NOTIFICATION_NEW_EVENT, notification }]);
  } finally {
    await Promise.all([removeNormal(), removeTest()]);
  }
});
