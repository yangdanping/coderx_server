import '../support/runtime-guard.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createHttpApp } from '../../src/http/app.js';
import { createAuthMiddleware } from '../../src/middleware/auth.middleware.js';
import { mediaMutationMaintenance } from '../../src/middleware/mediaMaintenance.middleware.js';

test('5C banned writes preserve the Koa JSON charset and byte length', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = createAuthMiddleware({
    publicKey: keys.publicKey,
    checkStatus: async () => 1,
    checkPermission: async () => assert.fail('banned request reached ownership lookup'),
  });
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => false, logRequest() {},
    registerRoutes(app) {
      app.post('/comment', auth.verifyAuth, auth.verifyStatus, () => assert.fail('banned request reached handler'));
    },
  });
  const response = await app.request('/comment', {
    method: 'POST', headers: { authorization: `Bearer ${jwt.sign({ id: 7 }, keys.privateKey, { algorithm: 'RS256' })}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('content-length'), '35');
  assert.equal(await response.text(), '{"msg":"您已被封禁","code":-1}');
});

test('5C maintenance blocks unauthenticated writes with the Koa JSON headers', async () => {
  const app = createHttpApp({
    buildId: 'test', checkReady: async () => false, logRequest() {},
    registerRoutes(app) {
      app.post('/article', mediaMutationMaintenance(() => true), () => assert.fail('maintenance reached next handler'));
    },
  });
  const response = await app.request('/article', { method: 'POST' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('content-length'), '90');
  assert.equal(await response.text(), '{"msg":"媒体上传和文章发布正在进行短时维护，请稍后重试","code":503}');
});
