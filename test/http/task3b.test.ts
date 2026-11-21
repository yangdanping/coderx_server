import BusinessError from '../../src/errors/BusinessError.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../src/http/app.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';

test('parses form and normalizes parser failures before the handler', async () => {
  let calls = 0;
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.post('/test', c => { calls++; return c.json(c.get('parsedBody')); });
  }});
  const form = await app.request('/test', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '11' }, body: 'a.b=1&a.b=2' });
  assert.deepEqual(await form.json(), { a: { b: ['1', '2'] } });
  const bad = await app.request('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '1' });
  assert.equal(bad.status, 500);
  assert.deepEqual(await bad.json(), { msg: '服务器内部错误', code: 500 });
  assert.equal(calls, 1);
});

test('maintenance is scoped and logs final status', async () => {
  const statuses: number[] = [];
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, logRequest: record => statuses.push(record.status), registerRoutes(app) {
    app.post('/test', mediaMutationMaintenance(() => true), c => c.text('ok'));
  }});
  const response = await app.request('/test', { method: 'POST' });
  assert.equal(response.status, 503);
  assert.deepEqual(statuses, [503]);
});

test('parser respects content types, strict JSON, and size limits', async () => {
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.post('/test', async c => c.json({ parsed: c.get('parsedBody'), remaining: c.req.raw.bodyUsed ? null : await c.req.text() }));
  }});
  const request = (type: string, body: string) => app.request('/test', { method: 'POST', headers: { 'content-type': type }, body });
  assert.deepEqual(await (await request('application/json;', '')).json(), { parsed: {}, remaining: null });
  assert.deepEqual(await (await request('application/other+json', '{"a":1}')).json(), { parsed: {}, remaining: '{"a":1}' });
  assert.deepEqual(await (await request('text/plain', 'secret')).json(), { parsed: {}, remaining: 'secret' });
  assert.equal((await request('application/json', '{"__proto__":{}}')).status, 500);
  assert.equal((await request('application/json', JSON.stringify({ x: 'a'.repeat(1048576) }))).status, 500);
});

test('structured logs omit request and error secrets and use normalized statuses', async () => {
  const records: unknown[] = [];
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, logRequest: record => records.push(record), registerRoutes(app) {
    app.post('/fail', () => { throw new Error('sensitive-error'); });
  }});
  const res = await app.request('/fail?password=secret', { method: 'POST', headers: { authorization: 'Bearer secret', cookie: 'secret', 'content-type': 'application/json' }, body: '{"prompt":"secret"}' });
  assert.equal(res.status, 500);
  assert.equal((records[0] as { status: number }).status, 500);
  assert.doesNotMatch(JSON.stringify(records), /secret|sensitive|prompt/i);
});

test('Node adapter returns normalized response for compressed chunked over-limit body', async () => {
  const { serve } = await import('@hono/node-server');
  const { request } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.post('/test', c => c.text('unexpected')); } });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: '/test', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(gzipSync(JSON.stringify({ x: 'a'.repeat(1048576) })));
    });
    assert.equal(status, 500);
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
});

test('parser preserves legacy responses for representative content types', async () => {
  const { serve } = await import('@hono/node-server');
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.post('/test', c => c.json(c.get('parsedBody')));
  } });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const cases = [
      ['application/json', '{"a":[1]}', 200, { a: [1] }],
      ['application/json', 'null', 500, { msg: '服务器内部错误', code: 500 }],
      ['application/vnd.api+json;', '{}', 200, {}],
      ['application/x-www-form-urlencoded', 'a.b=1&a.b=2', 200, { a: { b: ['1', '2'] } }],
      ['application/other+json', '{}', 200, {}],
    ] as const;
    for (const [type, body, status, expected] of cases) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/test`, { method: 'POST', headers: { 'content-type': type }, body });
      assert.equal(response.status, status, type);
      assert.deepEqual(await response.json(), expected, type);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('legacy emitted errors are distinct from ordinary thrown errors', async () => {
  const { LegacyEmittedError } = await import('../../src/http/legacyError.js');
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.get('/emitted', () => { throw new LegacyEmittedError('未认证/token无效'); });
    app.get('/thrown', () => { throw new Error('未认证/token无效'); });
  }});
  const emitted = await app.request('/emitted');
  assert.equal(emitted.status, 401);
  assert.deepEqual(await emitted.json(), { msg: '未认证/token无效', code: 401 });
  const thrown = await app.request('/thrown');
  assert.equal(thrown.status, 500);
  assert.deepEqual(await thrown.json(), { msg: '服务器内部错误', code: 500 });
});

test('business and upload failures retain their response and final status', async () => {
  const records: number[] = [];
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, logRequest: r => records.push(r.status), registerRoutes(app) {
    app.get('/business', () => { throw new BusinessError('example', 400, 40001); });
    app.get('/img/upload', () => { throw Object.assign(new Error('secret'), { code: 'LIMIT_FILE_SIZE', field: 'img' }); });
    app.get('/media/images', () => { throw new BusinessError('图片大小不能超过 10MB', 400); });
  }});
  const business = await app.request('/business');
  assert.deepEqual(await business.json(), { msg: 'example', code: 40001 });
  const image = await app.request('/img/upload');
  assert.deepEqual(await image.json(), { msg: '图片大小不能超过 20MB', code: 400 });
  const media = await app.request('/media/images');
  assert.deepEqual(await media.json(), { msg: '图片大小不能超过 10MB', code: 400 });
  await app.request('/missing');
  await app.request('/business', { method: 'POST' });
  assert.deepEqual(records, [400, 400, 400, 404, 405]);
});

test('decoded JSON and form limits accept exact boundary and reject one byte over', async () => {
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.post('/test', c => c.json(c.get('parsedBody'))); } });
  const send = (type: string, body: string) => app.request('/test', { method: 'POST', headers: { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) }, body });
  for (const [type, limit, wrap] of [['application/json', 1048576, (n: number) => `{"x":"${'a'.repeat(n - 8)}"}`], ['application/x-www-form-urlencoded', 57344, (n: number) => `x=${'a'.repeat(n - 2)}`]] as const) {
    assert.equal((await send(type, wrap(limit))).status, 200);
    assert.equal((await send(type, wrap(limit + 1))).status, 500);
  }
});

test('invalid error status properties normalize safely', async () => {
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) {
    app.get('/:value', c => { throw Object.assign(new Error('sensitive'), { httpStatus: c.req.param('value') === 'nan' ? NaN : c.req.param('value') === '999' ? 999 : '400', bizCode: 'secret' }); });
  }});
  for (const value of ['nan', '999', 'string']) {
    const response = await app.request('/' + value);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { msg: '服务器内部错误', code: 500 });
  }
});

test('Node GET JSON body is parsed', async () => {
  const { serve } = await import('@hono/node-server');
  const { request } = await import('node:http');
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.get('/test', c => c.json(c.get('parsedBody'))); } });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const result = await new Promise<{status: number | undefined; body: string}>((resolve, reject) => {
      const req = request({host: '127.0.0.1', port: address.port, path: '/test', method: 'GET', headers: {'content-type': 'application/json', 'content-length': '7'}}, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolve({status: res.statusCode, body})); }); req.on('error', reject); req.end('{"x":1}');
    });
    assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), {x: 1});
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('development policy is injected and sink failure cannot change response', async () => {
  const app = createHttpApp({ buildId: 'test', developmentErrors: true, checkReady: async () => true, logRequest() { throw new Error('sink secret'); }, registerRoutes(app) {
    app.get('/fail', () => { throw new Error('diagnostic'); });
    app.get('/ok', c => c.text('ok'));
  }});
  const failure = await app.request('/fail');
  assert.deepEqual(await failure.json(), { msg: '[DEV] diagnostic', code: 500 });
  assert.equal((await app.request('/ok')).status, 200);
});

test('over-limit streaming input is cancelled without waiting for the producer', async () => {
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(1048577).fill(32)); } }, cancel() { cancelled = true; } });
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.post('/test', c => c.text('unexpected')); } });
  const req = new Request('http://localhost/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const res = await app.fetch(req);
  assert.equal(res.status, 500);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('aborted streaming input settles the parser', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); controller.error(new Error('aborted')); } });
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.post('/test', c => c.text('unexpected')); } });
  const req = new Request('http://localhost/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const res = await app.fetch(req);
  assert.equal(res.status, 500);
});

test('Node GET and HEAD preserve valid, malformed and oversized JSON responses', async () => {
  const { serve } = await import('@hono/node-server');
  const { request } = await import('node:http');
  const candidate = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.get('/test', c => c.json(c.get('parsedBody'))); } });
  const current = serve({ fetch: candidate.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => current.once('listening', resolve));
  try {
    const address = current.address();
    assert.ok(address && typeof address !== 'string');
    const send = (port: number, method: string, body: string) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path: '/test', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }); req.on('error', reject); req.end(body);
    });
    for (const method of ['GET', 'HEAD']) {
      for (const [body, status, expected] of [
        ['{"x":1}', 200, { x: 1 }],
        ['{', 500, { msg: '服务器内部错误', code: 500 }],
        [JSON.stringify({ x: 'a'.repeat(1048576) }), 500, { msg: '服务器内部错误', code: 500 }],
      ] as const) {
        const actual = await send(address.port, method, body);
        assert.equal(actual.status, status, `${method} length=${body.length}`);
        if (method === 'GET') assert.deepEqual(JSON.parse(actual.body), expected);
        else assert.equal(actual.body, '');
      }
    }
  } finally {
    await new Promise<void>(resolve => current.close(() => resolve()));
  }
});

test('compressed streaming overflow cancels the upstream reader', async () => {
  const { gzipSync } = await import('node:zlib');
  const payload = gzipSync(JSON.stringify({ x: 'a'.repeat(1048576) }));
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { sent = true; controller.enqueue(payload); } }, cancel() { cancelled = true; } });
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.post('/test', c => c.text('unexpected')); } });
  const req = new Request('http://localhost/test', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  assert.equal((await app.fetch(req)).status, 500);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('compressed input aborted midstream normalizes and settles', async () => {
  const { gzipSync } = await import('node:zlib');
  const payload = gzipSync('{"x":1}');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(payload.subarray(0, 12));
    setImmediate(() => controller.error(new Error('upstream aborted')));
  }});
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, registerRoutes(app) { app.post('/test', c => c.text('unexpected')); } });
  const req = new Request('http://localhost/test', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const res = await app.fetch(req);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { msg: '服务器内部错误', code: 500 });
});

test('aborted compressed native GET and HEAD settle without breaking the listener', async () => {
  const { gzipSync } = await import('node:zlib');
  const { request } = await import('node:http');
  const { serve } = await import('@hono/node-server');
  const statuses: number[] = [];
  let notify: (() => void) | undefined;
  const app = createHttpApp({ buildId: 'test', checkReady: async () => true, logRequest(record) { statuses.push(record.status); notify?.(); }, registerRoutes(app) { app.get('/test', c => c.text('unexpected')); app.get('/ok', c => c.text('ok')); } });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const payload = gzipSync('{"x":1}');
    for (const method of ['GET', 'HEAD']) {
      const settled = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('parser did not settle')), 2000);
        notify = () => { clearTimeout(timeout); notify = undefined; resolve(); };
      });
      const req = request({ host: '127.0.0.1', port: address.port, path: '/test', method, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': payload.length } });
      req.on('error', () => {});
      req.write(payload.subarray(0, 12));
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      req.destroy();
      await settled;
      assert.equal(statuses.at(-1), 500);
    }
    const healthy = await fetch(`http://127.0.0.1:${address.port}/ok`);
    assert.equal(await healthy.text(), 'ok');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
