const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const middlewarePath = path.resolve(__dirname, '../../src/middleware/user.middleware.js');
const userServicePath = path.resolve(__dirname, '../../src/service/user.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadMiddleware(userService) {
  delete require.cache[middlewarePath];
  delete require.cache[userServicePath];
  injectCache(userServicePath, userService);
  return require(middlewarePath);
}

function createContext(body) {
  return {
    request: { body: { ...body } },
    app: {
      emit() {
        throw new Error('app.emit should not be called for this test');
      },
    },
  };
}

test('verifyUserRegister: trims a valid nickname before continuing', async () => {
  const lookups = [];
  const { verifyUserRegister } = loadMiddleware({
    async getUserByName(name) {
      lookups.push(name);
      return undefined;
    },
  });
  const ctx = createContext({ name: 'alice', password: 'secret', nickname: '  小杨  ' }); // pragma: allowlist secret
  let nextCount = 0;

  await verifyUserRegister(ctx, async () => {
    nextCount += 1;
  });

  assert.equal(ctx.request.body.nickname, '小杨');
  assert.deepEqual(lookups, ['alice']);
  assert.equal(nextCount, 1);
});

test('verifyUserRegister: maps omitted or blank nickname to null', async () => {
  const { verifyUserRegister } = loadMiddleware({
    async getUserByName() {
      return undefined;
    },
  });

  for (const body of [
    { name: 'alice', password: 'secret' }, // pragma: allowlist secret
    { name: 'alice', password: 'secret', nickname: '   ' }, // pragma: allowlist secret
  ]) {
    const ctx = createContext(body);
    await verifyUserRegister(ctx, async () => {});
    assert.equal(ctx.request.body.nickname, null);
  }
});

test('verifyUserRegister: rejects an invalid nickname before querying the account name', async () => {
  let lookupCount = 0;
  const { verifyUserRegister } = loadMiddleware({
    async getUserByName() {
      lookupCount += 1;
      return undefined;
    },
  });
  const ctx = createContext({ name: 'alice', password: 'secret', nickname: 'line\nbreak' }); // pragma: allowlist secret

  await assert.rejects(
    () => verifyUserRegister(ctx, async () => {}),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.httpStatus, 400);
      assert.equal(error.message, '昵称须为 1-30 个字符，且不能包含换行或控制字符');
      return true;
    },
  );
  assert.equal(lookupCount, 0);
});
