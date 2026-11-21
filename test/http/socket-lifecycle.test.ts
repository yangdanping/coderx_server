import { observeImports } from '../support/observe-imports.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { startSocketProcess } from '../../src/socket_server.js';
import type { NotificationEvent } from '../../src/socket/notification/notificationEvent.js';

async function withSocketEnv(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'coderx-socket-test-'));
  const previous = { APP_ENV_FILE: process.env.APP_ENV_FILE, CODERX_TEST_RESOURCE_ROOT: process.env.CODERX_TEST_RESOURCE_ROOT };
  try {
    process.env.CODERX_TEST_RESOURCE_ROOT = root;
    process.env.APP_ENV_FILE = join(root, '.env.socket');
    await writeFile(process.env.APP_ENV_FILE, '');
    await run(root);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function receive(socket: WebSocket, startsWith: string) {
  return new Promise<string>((done, fail) => {
    const listener = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== 'string' || !data.startsWith(startsWith)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      done(data);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener('message', listener);
      fail(new Error(`Socket packet not received: ${startsWith}`));
    }, 2000);
    socket.addEventListener('message', listener);
  });
}

test('Socket entry import is inert and explicit startup loads env before Socket.IO', async () => withSocketEnv(async root => {
  const script = `
    ${observeImports}
    const { startSocketProcess } = await import('./src/socket_server.js');
    const loadedSocketIo = () => [...loaded].some(p => p.includes('/socket.io/'));
    if (typeof startSocketProcess !== 'function' || loadedSocketIo()) process.exit(4);
    startSocketProcess().then(
      () => process.exit(5),
      error => { if (error.code !== 'ENOENT' || loadedSocketIo()) process.exit(6); },
    );
  `;
  const result = spawnSync(process.execPath, [
    '--require', resolve('test/support/runtime-guard.cjs'), '--import=tsx', '--input-type=module', '-e', script,
  ], {
    env: { ...process.env, APP_ENV_FILE: join(root, 'missing') },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
}));

test('Socket server delivers notification:new in the recipient room and closes live connections', async () => withSocketEnv(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = jwt.sign({ id: 7, name: 'Alice' }, privateKey, { algorithm: 'RS256' });
  let publish: ((payload: NotificationEvent, channel: string) => unknown) | undefined;
  let unsubscribed = 0;
  const runtime = await startSocketProcess({
    port: 0,
    host: '127.0.0.1',
    publicKey,
    userService: { getProfileById: async () => ({ avatarUrl: 'test-avatar' }) },
    presenceStoreOptions: { storeType: 'memory' },
    eventBus: {
      async subscribeNotificationEvents(handler) {
        publish = handler;
        return async () => { unsubscribed += 1; };
      },
    },
    configureRedisAdapter: async () => ({ enabled: false }),
    logger: { log() {}, warn() {}, error() {} },
  });
  let socket: WebSocket | undefined;
  try {
    const address = runtime.httpServer.address();
    assert(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'socket-server' });

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket&userId=99`);
    await receive(socket, '0');
    const presence = receive(socket, '42["online",');
    socket.send(`40${JSON.stringify({ token })}`);
    const online = JSON.parse((await presence).slice(2));
    assert.deepEqual(online[1].userList.map(({ userId, avatarUrl }: { userId: string; avatarUrl: string }) => ({ userId, avatarUrl })), [
      { userId: '7', avatarUrl: 'test-avatar' },
    ]);
    assert.equal(runtime.io.sockets.adapter.rooms.get('user:7')?.size, 1);
    assert.equal(runtime.io.sockets.adapter.rooms.has('user:99'), false);

    const received = receive(socket, '42["notification:new",');
    const notification = { id: 17, recipientId: 7, actorId: 99, type: 'follow' };
    await publish?.({ event: 'notification:new', notification }, 'coderx-test-only:notification:new');
    assert.deepEqual(JSON.parse((await received).slice(2)), ['notification:new', notification]);

    const disconnected = new Promise<void>(done => socket?.addEventListener('close', () => done(), { once: true }));
    await Promise.all([runtime.close(), runtime.close()]);
    await disconnected;
    assert.equal(runtime.io.sockets.sockets.size, 0);
    assert.equal(runtime.httpServer.listening, false);
    assert.equal(unsubscribed, 1);
  } finally {
    socket?.close();
    await runtime.close();
  }
}));
