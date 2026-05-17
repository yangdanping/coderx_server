const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NOTIFICATION_NEW_EVENT,
  buildNotificationChannel,
  createNotificationEventBus,
} = require('../../src/socket/notification/notificationEventBus');

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
