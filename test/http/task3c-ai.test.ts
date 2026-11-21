import jsonwebtoken from 'jsonwebtoken';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../src/http/app.js';
import { createAiRateLimits } from '../../src/middleware/ai.middleware.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { once } from 'node:events';

const jwt = jsonwebtoken as {
  sign(payload: object | string, key: KeyObject, options: { algorithm: 'RS256' }): string;
};

test('chat has a 12 request budget, counts failures, and resets at the boundary', async () => {
  let now = 0;
  const limits = createAiRateLimits(() => now);
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.get('/chat', limits.chat, () => { throw new Error('failure'); });
  }});
  for (let i = 0; i < 12; i++) assert.equal((await app.request('/chat')).status, 500);
  const blocked = await app.request('/chat');
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { msg: 'AI 请求过于频繁，请稍后再试', code: 429 });
  now = 59999;
  assert.equal((await app.request('/chat')).status, 429);
  now = 60000;
  assert.equal((await app.request('/chat')).status, 500);
});

test('chat limits use the Node peer rather than caller-controlled forwarded headers', async () => {
  const { serve } = await import('@hono/node-server');
  const { request } = await import('node:http');
  const limits = createAiRateLimits(() => 0);
  const statuses: number[] = [];
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => true,
    logRequest: record => statuses.push(record.status),
    registerRoutes(app) {
      app.post('/chat', limits.chat, c => {
        assert.equal(c.env?.incoming?.socket.remoteAddress, '127.0.0.1');
        return c.text('ok');
      });
    },
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const send = (localAddress: string, forwarded: string) => new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: address.port, localAddress, path: '/chat', method: 'POST',
        headers: { 'x-forwarded-for': forwarded, 'x-real-ip': forwarded, forwarded: `for=${forwarded}` },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('test request timed out')));
      req.end();
    });
    for (let i = 1; i <= 12; i++) assert.equal(await send('127.0.0.1', `192.0.2.${i}`), 200);
    assert.equal(await send('127.0.0.1', '198.51.100.1'), 429);
    assert.deepEqual(statuses, [...Array<number>(12).fill(200), 429]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('anonymous requests with distinct injected socket peers have separate budgets', async () => {
  const { IncomingMessage } = await import('node:http');
  const { Socket } = await import('node:net');
  const incoming = (address: string) => {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: address });
    return new IncomingMessage(socket);
  };
  const first = incoming('192.0.2.1');
  const second = incoming('192.0.2.2');
  const limits = createAiRateLimits(() => 0);
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.post('/chat', limits.chat, c => c.text('ok'));
  }});
  const send = (peer: typeof first) => app.fetch(new Request('http://localhost/chat', { method: 'POST' }), { incoming: peer });
  try {
    for (let i = 0; i < 12; i++) assert.equal((await send(first)).status, 200);
    assert.equal((await send(first)).status, 429);
    assert.equal((await send(second)).status, 200);
  } finally { first.destroy(); second.destroy(); }
});

test('chat and completion budgets are distinct and shared only within one factory', async () => {
  const makeApp = (limits: ReturnType<typeof createAiRateLimits>) => createHttpApp({
    buildId: 'test', checkReady: async () => true,
    registerRoutes(app) {
      app.post('/chat', limits.chat, c => c.text('ok'));
      app.post('/completion', limits.completion, c => c.text('ok'));
    },
  });
  const shared = createAiRateLimits(() => 0);
  const first = makeApp(shared);
  const sameInstance = makeApp(shared);
  const separateInstance = makeApp(createAiRateLimits(() => 0));
  const send = (app: typeof first, path: string) => app.request(path, { method: 'POST' });
  for (let i = 0; i < 12; i++) assert.equal((await send(first, '/chat')).status, 200);
  assert.equal((await send(sameInstance, '/chat')).status, 429);
  assert.equal((await send(separateInstance, '/chat')).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await send(first, '/completion')).status, 200);
  const blocked = await send(sameInstance, '/completion');
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { msg: 'AI 请求过于频繁，请稍后再试', code: 429 });
  assert.equal((await send(separateInstance, '/completion')).status, 200);
});

test('completion authenticates before consuming the 30 request budget and separates users', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = createAuthMiddleware({ publicKey, checkStatus: async () => false, checkPermission: async () => true });
  let now = 0;
  const limits = createAiRateLimits(() => now);
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.post('/completion', auth.verifyAuth, limits.completion, c => c.text('ok'));
  }});
  const alice = jwt.sign({ id: 7, name: 'Alice' }, privateKey, { algorithm: 'RS256' });
  const bob = jwt.sign({ id: 8, name: 'Bob' }, privateKey, { algorithm: 'RS256' });
  const send = (token?: string) => app.request('/completion', {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  for (let i = 0; i < 31; i++) assert.equal((await send(i % 2 ? 'invalid' : undefined)).status, 401);
  for (let i = 0; i < 30; i++) assert.equal((await send(alice)).status, 200);
  assert.equal((await send(alice)).status, 429);
  // Both users share the same peer; authenticated identity owns the completion budget.
  for (let i = 0; i < 30; i++) assert.equal((await send(bob)).status, 200);
  assert.equal((await send(bob)).status, 429);
  now = 59999;
  assert.equal((await send(alice)).status, 429);
  now = 60000;
  assert.equal((await send(alice)).status, 200);
});

test('completion preserves the legacy IP fallback for signed payloads without a truthy user id', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = createAuthMiddleware({ publicKey, checkStatus: async () => false, checkPermission: async () => true });
  const limits = createAiRateLimits(() => 0);
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.post('/completion', auth.verifyAuth, limits.completion, c => c.text('ok'));
  }});
  const tokens = ['legacy signed string', { name: 'NoId' }, { id: 0, name: 'Zero' }].map(payload =>
    jwt.sign(payload, privateKey, { algorithm: 'RS256' }));
  const send = (token: string) => app.request('/completion', { method: 'POST', headers: { authorization: token } });
  for (let i = 0; i < 30; i++) assert.equal((await send(tokens[i % tokens.length])).status, 200);
  for (const token of tokens) assert.equal((await send(token)).status, 429);
});
