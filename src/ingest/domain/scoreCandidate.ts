import type { FeedEntry } from '../ingest.types.js';

const AI_KEYWORDS = Object.freeze([
  'artificial intelligence',
  'machine learning',
  'generative ai',
  'deep learning',
  'transformer',
  'inference',
  'neural',
  'agent',
  'model',
  'llm',
  'gpt',
  'ai',
]);

function scoreRecency(publishedAt: string | null | undefined, now: Date | string) {
  const publishedTime = Date.parse(publishedAt ?? '');
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(publishedTime) || !Number.isFinite(nowTime)) return 0;

  const ageDays = Math.max(0, (nowTime - publishedTime) / 86_400_000);
  if (ageDays <= 1) return 40;
  if (ageDays <= 3) return 34;
  if (ageDays <= 7) return 28;
  if (ageDays <= 14) return 20;
  if (ageDays <= 30) return 12;
  return 0;
}

function scoreRelevance(candidate: Partial<Pick<FeedEntry, 'title' | 'summary'>>) {
  const searchableText = `${candidate.title || ''} ${candidate.summary || ''}`.toLowerCase();
  const hits = AI_KEYWORDS.filter((keyword) => searchableText.includes(keyword)).length;
  return Math.min(40, hits * 8);
}

function scoreCandidate(
  candidate: Pick<FeedEntry, 'title' | 'summary' | 'publishedAt'> | null | undefined,
  source: { trustScore?: unknown } | undefined,
  now: Date | string = new Date(),
) {
  const trustScore = Math.min(20, Math.max(0, Number(source?.trustScore) || 0));
  return Math.min(100, scoreRecency(candidate?.publishedAt, now) + scoreRelevance(candidate || {}) + trustScore);
}

export { scoreCandidate };
