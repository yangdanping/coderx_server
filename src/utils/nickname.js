const BusinessError = require('@/errors/BusinessError');

const NICKNAME_MAX_LENGTH = 30;
const INVALID_NICKNAME_MESSAGE = '昵称须为 1-30 个字符，且不能包含换行或控制字符';
function invalidNickname() {
  return new BusinessError(INVALID_NICKNAME_MESSAGE, 400);
}

function hasForbiddenNicknameCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029;
  });
}

function normalizeOptionalNickname(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalidNickname();

  const normalized = value.trim();
  return normalized || null;
}

function validateOptionalNickname(value) {
  const normalized = normalizeOptionalNickname(value);
  if (normalized == null) return null;

  const length = Array.from(normalized).length;
  if (length > NICKNAME_MAX_LENGTH || hasForbiddenNicknameCharacter(normalized)) {
    throw invalidNickname();
  }

  return normalized;
}

module.exports = {
  INVALID_NICKNAME_MESSAGE,
  NICKNAME_MAX_LENGTH,
  normalizeOptionalNickname,
  validateOptionalNickname,
};
