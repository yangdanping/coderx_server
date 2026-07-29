async function runWithLock(repository, callback) {
  if (!repository || typeof repository.withAdvisoryLock !== 'function') {
    throw new TypeError('repository.withAdvisoryLock is required');
  }
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function');
  }
  return await repository.withAdvisoryLock(callback);
}

module.exports = {
  runWithLock,
};
