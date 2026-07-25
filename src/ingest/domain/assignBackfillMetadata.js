const crypto = require('node:crypto');

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function hashInteger(value) {
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function normalizedCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('At least one candidate is required');
  }
  const normalized = candidates.map((candidate) => {
    const id = Number(candidate?.id);
    const canonicalUrl = String(candidate?.canonicalUrl || '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !canonicalUrl) {
      throw new Error('Every candidate requires a positive id and canonicalUrl');
    }
    return { ...candidate, id, canonicalUrl };
  });
  const uniqueUrls = new Set(normalized.map((candidate) => candidate.canonicalUrl));
  if (uniqueUrls.size !== normalized.length) throw new Error('Candidate canonicalUrl values must be unique');
  return normalized.sort((left, right) => (left.canonicalUrl < right.canonicalUrl ? -1 : left.canonicalUrl > right.canonicalUrl ? 1 : 0));
}

function normalizedAuthorIds(authorIds) {
  if (!Array.isArray(authorIds) || authorIds.length < 2) {
    throw new Error('At least two author IDs are required');
  }
  const normalized = authorIds.map(Number);
  if (normalized.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(normalized).size !== normalized.length) {
    throw new Error('Author IDs must be unique positive integers');
  }
  return normalized;
}

function assignAuthors(candidates, authorIds) {
  const orderedCandidates = normalizedCandidates(candidates);
  const authors = normalizedAuthorIds(authorIds);
  const batchKey = orderedCandidates.map((candidate) => candidate.canonicalUrl).join('\n');
  const startIndex = hashInteger(batchKey) % authors.length;
  const assignments = new Map();

  orderedCandidates.forEach((candidate, index) => {
    assignments.set(candidate.id, authors[(startIndex + index) % authors.length]);
  });
  return assignments;
}

function assignBackfillDates(candidates, { now = new Date(), days = 30 } = {}) {
  const orderedCandidates = normalizedCandidates(candidates);
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error('now must be a valid date');
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error('days must be a positive integer');

  const rangeMs = days * DAY_MS;
  const bucketMs = rangeMs / orderedCandidates.length;
  const assignments = new Map();

  orderedCandidates.forEach((candidate, index) => {
    const fraction = hashInteger(candidate.canonicalUrl) / 0x1_0000_0000;
    const ageMs = Math.max(MINUTE_MS, index * bucketMs + fraction * bucketMs);
    const clampedAge = Math.min(rangeMs, ageMs);
    assignments.set(candidate.id, new Date(nowDate.getTime() - clampedAge));
  });
  return assignments;
}

module.exports = {
  assignAuthors,
  assignBackfillDates,
};
