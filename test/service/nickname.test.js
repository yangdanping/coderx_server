const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('module-alias/register');

const helperPath = path.resolve(__dirname, '../../src/utils/nickname.js');
const INVALID_NICKNAME_MESSAGE = '昵称须为 1-30 个字符，且不能包含换行或控制字符';

function loadNicknameHelper() {
  assert.equal(fs.existsSync(helperPath), true, 'Expected nickname utility module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
}

test('normalizeOptionalNickname: trims input and maps missing or blank values to null', () => {
  const { normalizeOptionalNickname } = loadNicknameHelper();

  assert.equal(normalizeOptionalNickname(undefined), null);
  assert.equal(normalizeOptionalNickname(null), null);
  assert.equal(normalizeOptionalNickname(' \t '), null);
  assert.equal(normalizeOptionalNickname('  小杨  '), '小杨');
});

test('validateOptionalNickname: accepts shareable Unicode text and emoji up to 30 code points', () => {
  const { validateOptionalNickname } = loadNicknameHelper();
  const thirtyCodePoints = '杨'.repeat(28) + '🙂🙂';

  assert.equal(Array.from(thirtyCodePoints).length, 30);
  assert.equal(validateOptionalNickname(thirtyCodePoints), thirtyCodePoints);
  assert.equal(validateOptionalNickname('  Coder X 🙂  '), 'Coder X 🙂');
});

test('validateOptionalNickname: rejects values longer than 30 Unicode code points', () => {
  const { validateOptionalNickname } = loadNicknameHelper();

  assert.throws(
    () => validateOptionalNickname('🙂'.repeat(31)),
    (error) => {
      assert.equal(error.name, 'BusinessError');
      assert.equal(error.httpStatus, 400);
      assert.equal(error.message, INVALID_NICKNAME_MESSAGE);
      return true;
    },
  );
});

test('validateOptionalNickname: rejects line separators and C0/C1 control characters', () => {
  const { validateOptionalNickname } = loadNicknameHelper();

  for (const value of ['hello\nworld', 'hello\u0000world', 'hello\u0085world', 'hello\u2028world', 'hello\u2029world']) {
    assert.throws(() => validateOptionalNickname(value), {
      name: 'BusinessError',
      message: INVALID_NICKNAME_MESSAGE,
    });
  }
});

test('validateOptionalNickname: rejects non-string values instead of coercing them', () => {
  const { validateOptionalNickname } = loadNicknameHelper();

  for (const value of [1, true, {}, []]) {
    assert.throws(() => validateOptionalNickname(value), {
      name: 'BusinessError',
      message: INVALID_NICKNAME_MESSAGE,
    });
  }
});
