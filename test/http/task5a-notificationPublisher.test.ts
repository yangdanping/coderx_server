import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createNotificationPublisher } from '../../src/socket/notification/notificationPublisher.js';

test('follow publisher connects lazily, retries a connection failure and keeps the shared wire contract', async () => {
  let clients = 0;
  let destroyed = 0;
  let published = 0;
  const publisher = createNotificationPublisher({
    redisUrl: 'redis://fixture.example.test:1234/9',
    keyPrefix: 'isolated-prefix',
    logError() {},
    createClient(url) {
      assert.equal(url, 'redis://fixture.example.test:1234/9');
      const attempt = ++clients;
      const events = new EventEmitter();
      return Object.assign(events, {
        isOpen: false,
        isReady: false,
        async connect() {
          if (attempt === 1) throw new Error('fixture connection failure');
          this.isOpen = this.isReady = true;
          events.emit('connect');
        },
        async publish(channel: string, payload: string) {
          assert.equal(channel, 'isolated-prefix:notification:new');
          assert.equal(payload, '{"event":"notification:new","notification":{"id":15,"type":"follow"}}');
          if (++published === 1) throw new Error('fixture publish failure');
          return 1;
        },
        destroy() { destroyed++; this.isOpen = this.isReady = false; },
      });
    },
  });
  const notification = { id: 15, type: 'follow' };
  try {
    assert.equal(clients, 0);
    await assert.rejects(publisher.publishNotificationCreated(notification), /fixture connection failure/);
    await assert.rejects(publisher.publishNotificationCreated(notification), /fixture publish failure/);
    assert.equal(await publisher.publishNotificationCreated(notification), 1);
    assert.equal(clients, 2);
  } finally {
    await publisher.close();
  }
  await publisher.close();
  await assert.rejects(publisher.publishNotificationCreated(notification), /publisher is closed/);
  assert.equal(destroyed, 1);
});

test('follow publisher closes a connecting client after its TCP socket attaches', async () => {
  let destroyedBeforeAttach = false;
  let closedSocket = false;
  let published = false;
  let connected = false;
  let rejectConnection!: (error: Error) => void;
  const connection = new Promise<void>((_, reject) => { rejectConnection = reject; });
  const client = Object.assign(new EventEmitter(), {
    isOpen: false,
    isReady: false,
    connect() {
      this.isOpen = true;
      return connection;
    },
    async publish() { published = true; return 1; },
    destroy() {
      this.isOpen = this.isReady = false;
      if (connected) closedSocket = true;
      else destroyedBeforeAttach = true;
      rejectConnection(new Error('fixture socket closed'));
    },
  });
  const publisher = createNotificationPublisher({
    keyPrefix: 'isolated-prefix',
    logError() {},
    createClient: () => client,
  });
  const rejected = assert.rejects(publisher.publishNotificationCreated({ id: 15 }), /fixture socket closed/);
  const shutdown = publisher.close();
  connected = true;
  client.emit('connect');
  await shutdown;
  await rejected;
  assert.equal(destroyedBeforeAttach, false);
  assert.equal(closedSocket, true);
  assert.equal(published, false);
});
