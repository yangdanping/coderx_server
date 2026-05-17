const test = require('node:test');
const assert = require('node:assert/strict');

const initializeSocketNotifications = require('../../src/socket/notification/socketio-notification');

function createFakeIo() {
  const rooms = [];
  return {
    handlers: {},
    emissions: [],
    rooms,
    on(event, handler) {
      this.handlers[event] = handler;
    },
    to(room) {
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
  initializeSocketNotifications(io, {
    eventBus: {
      async subscribeNotificationEvents() {},
    },
  });
  const socket = createFakeSocket({ mode: 'user', userId: '7' });

  await io.handlers.connection(socket);

  assert.deepEqual(socket.joinedRooms, ['user:7']);
});

test('socketio-notification: Redis notification events emit to recipient room', async () => {
  const io = createFakeIo();
  let notificationHandler;
  await initializeSocketNotifications(io, {
    eventBus: {
      async subscribeNotificationEvents(handler) {
        notificationHandler = handler;
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
