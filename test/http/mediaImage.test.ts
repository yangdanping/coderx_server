import jsonwebtoken from 'jsonwebtoken';
import { frozenHttpContract } from '../support/frozen-http-contract.js';
import '../support/runtime-guard.cjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import sharp, { type SharpOptions } from 'sharp';
import { MAX_FLOW_IMAGE_FILE_SIZE, MAX_FLOW_IMAGE_PIXELS } from '../../src/constants/upload.js';
import { createHttpApp } from '../../src/http/app.js';
import { createVerifyAuth } from '../../src/middleware/auth.middleware.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';
import type { AppEnv } from '../../src/http/types.js';

import { mediaImageUpload } from '../../src/middleware/mediaImage.middleware.js';
import { registerMediaRoutes } from '../../src/router/media.router.js';
import { createMediaImageUploadService } from '../../src/service/mediaImage/mediaImage.service.js';
import { decodeMediaImage } from '../../src/service/mediaImageInput.service.js';

const jwt = jsonwebtoken as {
  sign(payload: object, key: ReturnType<typeof generateKeyPairSync>['privateKey'], options: { algorithm: 'RS256' }): string;
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const auth = jwt.sign({ id: 19 }, keys.privateKey, { algorithm: 'RS256' });
const formatError = '图片必须是 JPEG、PNG 或 WebP 格式';
const sizeError = '图片大小不能超过 10MB';
const pixelError = '图片像素不能超过 40,000,000';
const uploadPath = '/fixture/images';
const requestEvents = ['data', 'end', 'error', 'aborted', 'close'] as const;

const fixtures = Promise.all((['jpeg', 'png', 'webp'] as const).map(format =>
  sharp({ create: { width: 12, height: 8, channels: 4, background: 'red' } }).toFormat(format).toBuffer(),
));

function listenerCounts(incoming?: AppEnv['Bindings']['incoming']) {
  return requestEvents.map(event => incoming?.listenerCount(event));
}

function fixture(options: {
  paused?: boolean;
  developmentErrors?: boolean;
  fail?: Error;
  watchRead?: () => void;
  observe?: (state: { before: ReturnType<typeof listenerCounts>; after: ReturnType<typeof listenerCounts>; read?: boolean; upload?: unknown; body: unknown; status: number }) => void;
} = {}) {
  let handled = 0;
  const app = createHttpApp({
    buildId: 'test',
    checkReady: async () => true,
    developmentErrors: options.developmentErrors,
    registerRoutes(app) {
      app.post(uploadPath, async (c, next) => {
        const incoming = c.env?.incoming;
        if (options.watchRead) incoming?.once('data', options.watchRead);
        const before = listenerCounts(incoming);
        await next();
        options.observe?.({ before, after: listenerCounts(incoming), read: incoming?.readableDidRead, upload: c.get('mediaImageFile'), body: c.get('parsedBody'), status: c.res.status });
      }, mediaMutationMaintenance(() => options.paused === true), createVerifyAuth(keys.publicKey), mediaImageUpload, async c => {
        handled += 1;
        const file = c.get('mediaImageFile');
        const decoded = await decodeMediaImage(file);
        assert.ok(file);
        if (options.fail) throw options.fail;
        const { buffer, ...metadata } = file;
        return c.json({
          user: c.get('user'),
          fields: c.get('parsedBody'),
          file: metadata,
          prefix: buffer.subarray(0, 12).toString('hex'),
          decoded: { format: decoded.info.format, width: decoded.info.width, height: decoded.info.height },
        });
      });
      app.get('/fixture/outside', () => { throw options.fail ?? new Error('unexpected fixture route'); });
    },
  });
  return { app, handled: () => handled };
}

async function withServer<T>(app: ReturnType<typeof createHttpApp>, run: (origin: string, port: number) => Promise<T>) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false });
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return await run(`http://127.0.0.1:${address.port}`, address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
  }
}

function multipart(...files: { name?: string; filename?: string; mime?: string; data: Buffer }[]) {
  const form = new FormData();
  for (const file of files) {
    form.append(file.name ?? 'image', new Blob([new Uint8Array(file.data)], { type: file.mime ?? 'image/png' }), file.filename ?? 'sample.png');
  }
  return form;
}

test('the mounted image collection preserves legacy raw paths and methods, and maintenance precedes auth and upload', async t => {
  const imageRoot = await mkdtemp(join(tmpdir(), 'hono-media-paths-'));
  t.after(() => rm(imageRoot, { recursive: true, force: true }));
  let paused = false;
  const app = createHttpApp({
    buildId: 'test',
    checkReady: async () => false,
    registerRoutes(app) {
      registerMediaRoutes(app, {
        maintenance: mediaMutationMaintenance(() => paused),
        verifyAuth: createVerifyAuth(keys.publicKey),
        uploadImage: mediaImageUpload,
        service: {
          async deletePendingImage() { assert.fail('path negotiation must not call the delete service'); },
          ...createMediaImageUploadService({
            database: { async getConnection() { assert.fail('invalid requests must not acquire a database connection'); } },
            publicApiOrigin: 'https://api.example.test',
            imageRoot,
            async resolveImageUrl() { assert.fail('invalid requests must not resolve URLs'); },
          }),
        },
      });
    },
  });
  const contract = frozenHttpContract('mediaImage');
  function rawRequest(port: number, path: string, method: string) {
    return new Promise<{ status?: number; allow?: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { authorization: auth }, signal: AbortSignal.timeout(2000) }, response => {
        response.resume();
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, allow: response.headers.allow }));
      });
      request.once('error', reject);
      request.end();
    });
  }
  await withServer(app, async (origin, port) => {
    for (const [path, method] of [
      ['/MEDIA/IMAGES/', 'POST'], ['/media/images', 'POST'], ['/media/images//', 'POST'],
      ['/media/%69mages', 'POST'], ['/a/../media/images', 'POST'], ['/media/images', 'OPTIONS'],
      ['/media/images/', 'GET'], ['/media/images', 'HEAD'], ['/media/images/', 'PROPFIND'],
      ['/MEDIA/IMAGES/7/', 'OPTIONS'], ['/media/images/7', 'POST'], ['/media/images/7/', 'HEAD'],
    ]) {
      contract.assert(method, path, await rawRequest(port, path, method));
    }
    contract.assertComplete();
    paused = true;
    const blocked = await fetch(origin + '/media/images', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'missing boundary and token',
    });
    await expectError(blocked, 503, '媒体上传和文章发布正在进行短时维护，请稍后重试');
  });
});

function post(origin: string, body?: FormData | Buffer, contentType?: string) {
  return fetch(origin + uploadPath, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, ...(contentType ? { 'content-type': contentType } : {}) },
    body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
    signal: AbortSignal.timeout(5000),
  });
}

async function expectError(response: Response, status: number, msg: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { msg, code: status });
}

test('Node parses and decodes JPEG, PNG and WebP with legacy file metadata and multipart fields', async () => {
  const { app, handled } = fixture();
  await withServer(app, async origin => {
    const images = await fixtures;
    for (const [index, format] of (['jpeg', 'png', 'webp'] as const).entries()) {
      const image = images[index];
      const name = `50%"${format}.data`;
      const form = multipart({ data: image, mime: `image/${format}`, filename: name });
      form.append('caption', 'first');
      form.append('caption', 'second');
      form.append('metadata[label]', 'example');
      form.append('note"x', 'quoted');
      form.append('image', 'text can share the file field');
      const response = await post(origin, form);
      assert.equal(response.status, 200, await response.clone().text());
      const { user, fields, file, prefix, decoded } = await response.json();
      assert.equal(user.id, 19);
      assert.deepEqual(fields, { caption: ['first', 'second'], metadata: { label: 'example' }, 'note"x': 'quoted', image: 'text can share the file field' });
      assert.deepEqual(file, { kind: 'memory', fieldname: 'image', originalname: name, encoding: '7bit', mimetype: `image/${format}`, size: image.length });
      assert.equal(prefix, image.subarray(0, 12).toString('hex'));
      assert.deepEqual(decoded, { format: 'webp', width: 12, height: 8 });
    }
  });
  assert.equal(handled(), 3);
});

test('app.request parses FormData with no explicit framing headers', async () => {
  const { app } = fixture();
  const [, data] = await fixtures;
  const response = await app.request(uploadPath, { method: 'POST', headers: { authorization: auth }, body: multipart({ data }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).file.size, data.length);
});

test('a malformed multipart header releases the app.request body', async () => {
  const { app, handled } = fixture({ developmentErrors: true });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'multipart/form-data' },
    body,
    duplex: 'half',
  };
  const request = new Request(`http://localhost${uploadPath}`, init);
  await expectError(await app.request(request), 500, '[DEV] Multipart: Boundary not found');
  assert.equal(cancelled, true);
  assert.equal(handled(), 0);
});

test('missing files, duplicate files and unexpected file fields retain legacy errors', async () => {
  const { app, handled } = fixture({ developmentErrors: true });
  const [, data] = await fixtures;
  await withServer(app, async origin => {
    const textOnly = new FormData();
    textOnly.append('image', 'text');
    await expectError(await post(origin), 400, '请选择要上传的图片');
    await expectError(await post(origin, textOnly), 400, '请选择要上传的图片');
    await expectError(await post(origin, multipart({ name: 'photo', data })), 500, '[DEV] Unexpected file field');
    await expectError(await post(origin, multipart({ data }, { data })), 500, '[DEV] Unexpected file field');
  });
  assert.equal(handled(), 2);
});

test('Node rejects unsupported declared MIME before downstream and rejects empty, mismatched and corrupt image data', async () => {
  const { app, handled } = fixture();
  const [, data] = await fixtures;
  const corrupt = data.subarray(0, data.length - 20);
  assert.equal((await sharp(corrupt).metadata()).format, 'png');
  await withServer(app, async origin => {
    await expectError(await post(origin, multipart({ data, mime: 'image/gif' })), 400, formatError);
    assert.equal(handled(), 0);
    for (const file of [{ data: Buffer.alloc(0) }, { data, mime: 'image/jpeg' }, { data: Buffer.from('not an image') }, { data: corrupt }]) {
      await expectError(await post(origin, multipart(file)), 400, formatError);
    }
    assert.equal(handled(), 4);
  });
});

test('Node accepts a 10 MiB file and rejects 10 MiB + 1 without reaching downstream', async () => {
  const { app, handled } = fixture();
  const [jpeg] = await fixtures;
  const limit = Buffer.alloc(MAX_FLOW_IMAGE_FILE_SIZE);
  jpeg.copy(limit);
  const excess = Buffer.alloc(MAX_FLOW_IMAGE_FILE_SIZE + 1);
  jpeg.copy(excess);
  await withServer(app, async origin => {
    const response = await post(origin, multipart({ data: limit, mime: 'image/jpeg' }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).file.size, MAX_FLOW_IMAGE_FILE_SIZE);
    await expectError(await post(origin, multipart({ data: excess, mime: 'image/jpeg' })), 400, sizeError);
  });
  assert.equal(handled(), 1);
});

test('Sharp rejects a real over-limit PNG and accepts exactly 40,000,000 pixels', async () => {
  const { app } = fixture();
  await withServer(app, async origin => {
    for (const width of [8000, 8001]) {
      const data = await sharp({ create: { width, height: 5000, channels: 3, background: 'red' } }).png().toBuffer();
      const response = await post(origin, multipart({ data }));
      if (width === 8000) {
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual((await response.json()).decoded, { format: 'webp', width: 2560, height: 1600 });
      } else {
        await expectError(response, 400, pixelError);
      }
    }
  });
});

test('the metadata limit also rejects one extra pixel from the injected decoder', async () => {
  const [, buffer] = await fixtures;
  const factory = (_input: Buffer, options: SharpOptions) => {
    assert.deepEqual(options, { failOn: 'warning', limitInputPixels: MAX_FLOW_IMAGE_PIXELS });
    return {
      metadata: async () => ({ format: 'png' as const, width: MAX_FLOW_IMAGE_PIXELS + 1, height: 1 }),
      rotate() { assert.fail('pixel limit must prevent decoding'); },
    };
  };
  await assert.rejects(decodeMediaImage({ buffer, mimetype: 'image/png' }, factory),
    { message: pixelError, httpStatus: 400, bizCode: 400 });
});

test('malformed and truncated multipart bodies never reach downstream', async () => {
  const { app, handled } = fixture({ developmentErrors: true });
  const [, data] = await fixtures;
  const opening = Buffer.from('--fixture\r\nContent-Disposition: form-data; name="image"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n');
  await withServer(app, async origin => {
    await expectError(await post(origin, data, 'multipart/form-data'), 500, '[DEV] Multipart: Boundary not found');
    await expectError(await post(origin, Buffer.from('--fixture\r\nInvalid header\r\n\r\n'), 'multipart/form-data; boundary=fixture'), 500, '[DEV] Malformed part header');
    await expectError(await post(origin, Buffer.concat([opening, data]), 'multipart/form-data; boundary=fixture'), 500, '[DEV] Unexpected end of form');
    assert.equal(handled(), 0);
    assert.equal((await post(origin, multipart({ data }))).status, 200);
  });
});

test('maintenance and failed JWT authentication return before the Node request body is consumed', async () => {
  for (const paused of [true, false]) {
    const states: (boolean | undefined)[] = [];
    const { app, handled } = fixture({ paused, observe: ({ read }) => states.push(read) });
    await withServer(app, async origin => {
      const response = await fetch(origin + uploadPath, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data', ...(paused ? { authorization: auth } : { authorization: 'invalid-token' }) },
        body: 'intentionally invalid',
      });
      if (paused) {
        await expectError(response, 503, '媒体上传和文章发布正在进行短时维护，请稍后重试');
        const missingToken = await fetch(origin + uploadPath, { method: 'POST' });
        await expectError(missingToken, 503, '媒体上传和文章发布正在进行短时维护，请稍后重试');
      } else {
        await expectError(response, 401, '未认证/token无效');
      }
    });
    assert.deepEqual(states, paused ? [false, false] : [false]);
    assert.equal(handled(), 0);
  }
});

test('file and multipart fields are released after downstream failure and the size error mapping stays scoped', async () => {
  const observations: { upload?: unknown; body: unknown; before: ReturnType<typeof listenerCounts>; after: ReturnType<typeof listenerCounts> }[] = [];
  const failure = Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE', field: 'image' });
  const { app, handled } = fixture({ fail: failure, observe: state => observations.push(state) });
  const [, data] = await fixtures;
  await withServer(app, async origin => {
    await expectError(await post(origin, multipart({ data })), 400, sizeError);
    await expectError(await fetch(origin + '/fixture/outside'), 500, '服务器内部错误');
  });
  assert.equal(handled(), 1);
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].body, {});
  assert.equal(observations[0].upload, undefined);
  assert.deepEqual(observations[0].after, observations[0].before);
});

test('an interrupted upload settles, removes its incoming listeners and leaves the next request usable', { timeout: 5000 }, async () => {
  let markRead!: () => void;
  const reading = new Promise<void>(resolve => { markRead = resolve; });
  let markFinished!: (state: { before: ReturnType<typeof listenerCounts>; after: ReturnType<typeof listenerCounts>; status: number; upload?: unknown }) => void;
  const finished = new Promise<Parameters<typeof markFinished>[0]>(resolve => { markFinished = resolve; });
  const { app, handled } = fixture({ watchRead: markRead, observe: markFinished });
  const [, data] = await fixtures;
  await withServer(app, async (origin, port) => {
    const client = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: uploadPath,
      headers: { authorization: auth, 'content-type': 'multipart/form-data; boundary=fixture', 'content-length': 100_000 },
    });
    client.on('error', () => {});
    client.write('--fixture\r\nContent-Disposition: form-data; name="image"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n');
    client.write(data);
    try {
      await reading;
    } finally {
      client.destroy();
    }
    const state = await finished;
    assert.equal(state.status, 500);
    assert.equal(state.upload, undefined);
    assert.equal(state.after[0], Number(state.before[0]) - 1);
    assert.deepEqual(state.after.slice(1), state.before.slice(1));
    assert.equal(handled(), 0);
    assert.equal((await post(origin, multipart({ data }))).status, 200);
  });
});
