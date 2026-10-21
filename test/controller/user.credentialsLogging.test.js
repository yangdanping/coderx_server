const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { inspect } = require('node:util');
const jwt = require('jsonwebtoken');
require('module-alias/register');

const root = path.resolve(__dirname, '../..');
function inject(relative, exports) {
  const filename = path.join(root, relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const requestRecords = [];
inject('src/app/logger.js', {
  requestLogger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((method) => [method, (...args) => requestRecords.push(inspect(args, { depth: null }))])),
});
const loggerMiddleware = require('../../src/middleware/logger.middleware');
const utils = require('../../src/utils');
const password = 'login-credential-sentinel'; // pragma: allowlist secret
const hash = utils.hashPwd(password);
const user = { id: 42, name: 'alice', password: hash };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
inject('src/app/config.js', { PRIVATE_KEY: privateKey });
inject('src/service/user.service.js', {
  async getUserByName() {
    return user;
  },
  async addUser(body) {
    assert.equal(body.password, hash);
    return { id: user.id };
  },
});
for (const service of ['article', 'file', 'avatar']) inject(`src/service/${service}.service.js`, {});
const { verifyUserLogin, verifyUserRegister } = require('../../src/middleware/user.middleware');
const controller = require('../../src/controller/user.controller');

async function captureLogs(t, run) {
  const messages = [];
  requestRecords.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => messages.push(inspect(args, { depth: null })));
  }
  await run();
  const output = [...messages, ...requestRecords].join('\n');
  assert.ok(!output.includes(password), 'logger received a plaintext password');
  assert.ok(!output.includes(hash), 'logger received a password hash');
  return output;
}

test('login responds with a valid token without logging credentials or the token', async (t) => {
  const ctx = { method: 'POST', url: '/login', ip: '127.0.0.1', status: 200, request: { body: { name: user.name, password } } };
  const output = await captureLogs(t, async () => {
    await loggerMiddleware(ctx, () => verifyUserLogin(ctx, () => controller.userLogin(ctx)));
  });
  const token = ctx.body.data.token;
  assert.equal(jwt.verify(token, publicKey, { algorithms: ['RS256'] }).id, user.id);
  assert.ok(!output.includes(token), 'logger received a bearer token');
});

test('registration persists a hash without logging it', async (t) => {
  const ctx = { method: 'POST', url: '/user', ip: '127.0.0.1', status: 200, request: { body: { name: user.name, password: hash } } };
  await captureLogs(t, () => loggerMiddleware(ctx, () => controller.addUser(ctx)));
  assert.equal(ctx.body.data.id, user.id);
});

for (const [label, verify] of [
  ['registration', verifyUserRegister],
  ['login', verifyUserLogin],
]) {
  test(`${label} validation does not log a supplied password when username is missing`, async (t) => {
    let rejected = false;
    const ctx = {
      request: { body: { password } },
      app: {
        emit() {
          rejected = true;
        },
      },
    };
    await captureLogs(t, () => verify(ctx, () => assert.fail('invalid credentials continued')));
    assert.equal(rejected, true);
  });
}
