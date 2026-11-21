import type { IngestRepository } from '../repositories/ingestRepository.js';

function requiredName(value: unknown, fieldName: string) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error(`${fieldName} is required`);
  return name;
}

async function publishCandidates({
  repository,
  authorName,
  tagName,
  limit = 10,
}: {
  repository: Pick<IngestRepository, 'publishApproved'>;
  authorName: string;
  tagName: string;
  limit?: number;
}) {
  return await repository.publishApproved({
    authorName: requiredName(authorName, 'authorName'),
    tagName: requiredName(tagName, 'tagName'),
    limit,
  });
}

export { publishCandidates };
