import test from 'node:test';
import assert from 'node:assert/strict';

import initializeSocketNotifications from '../../src/socket/notification/socketio-notification.js';

function createFakeIo() {
  const rooms = [];
  return {
    handlers: {},
    emissions: [],
    rooms,
    on(event, handler) {
      this.handlers[event] = handler;
    },
    off(event, handler) {
      if (this.handlers[event] === handler) delete this.handlers[event];
    },
    get local() {
      return { to: this.toLocal.bind(this) };
    },
    toLocal(room) {
      rooms.push(room);
      return {
        emit: (event, payload) => {
          this.emissions.push({ room, event, payload });
        },
      };
    },
  };
}

function createFakeSocket(presenceAuth) {
  return {
    data: { presenceAuth },
    joinedRooms: [],
    join(room) {
      this.joinedRooms.push(room);
    },
  };
}

test('socketio-notification: authenticated users join their notification room', async () => {
  const io = createFakeIo();
  const runtime = await initializeSocketNotifications(io, {
    eventBus: {
      async subscribeNotificationEvents() { return async () => {}; },
    },
  });
  const socket = createFakeSocket({ mode: 'user', userId: '7' });

  await io.handlers.connection(socket);

  assert.deepEqual(socket.joinedRooms, ['user:7']);
  await runtime.close();
  assert.equal(io.handlers.connection, undefined);
});

test('socketio-notification: Redis notification events emit only to the local recipient room', async () => {
  const io = createFakeIo();
  let notificationHandler;
  await initializeSocketNotifications(io, {
    eventBus: {
      async subscribeNotificationEvents(handler) {
        notificationHandler = handler;
        return async () => {};
      },
    },
  });

  await notificationHandler({
    event: 'notification:new',
    notification: { id: 88, recipientId: 10, actorId: 20, articleId: 30 },
  });

  assert.deepEqual(io.emissions, [
    {
      room: 'user:10',
      event: 'notification:new',
      payload: { id: 88, recipientId: 10, actorId: 20, articleId: 30 },
    },
  ]);
});
