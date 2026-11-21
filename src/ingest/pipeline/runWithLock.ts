import type { IngestRepository } from '../repositories/ingestRepository.js';

async function runWithLock<Result>(repository: Pick<IngestRepository, 'withAdvisoryLock'>, callback: () => Result | Promise<Result>) {
  if (!repository || typeof repository.withAdvisoryLock !== 'function') {
    throw new TypeError('repository.withAdvisoryLock is required');
  }
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function');
  }
  return await repository.withAdvisoryLock(callback);
}

export { runWithLock };
