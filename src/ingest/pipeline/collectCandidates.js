const crypto = require('node:crypto');
const { normalizeCanonicalUrl } = require('@/ingest/domain/normalizeUrl');
const { scoreCandidate } = require('@/ingest/domain/scoreCandidate');

function createContentHash(title, summary) {
  const normalizedText = `${title || ''}\n${summary || ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return normalizedText ? crypto.createHash('sha256').update(normalizedText).digest('hex') : null;
}

function normalizeEntry(entry, source, now, cutoffTime, minScore) {
  const canonicalUrl = normalizeCanonicalUrl(entry.url);
  const publishedTime = Date.parse(entry.publishedAt);
  if (!canonicalUrl || !entry.title || !Number.isFinite(publishedTime) || publishedTime < cutoffTime) return null;

  const score = scoreCandidate(entry, source, now);
  if (score < minScore) return null;

  return {
    sourceKey: source.sourceKey,
    externalId: entry.externalId || canonicalUrl,
    canonicalUrl,
    titleOriginal: entry.title.trim(),
    summaryOriginal: entry.summary?.trim() || '',
    authorOriginal: entry.author?.trim() || '',
    sourcePublishedAt: new Date(publishedTime).toISOString(),
    contentMode: source.contentMode,
    licenseCode: source.licenseCode,
    rawPayload: entry.raw && typeof entry.raw === 'object' ? entry.raw : {},
    contentHash: createContentHash(entry.title, entry.summary),
    score,
  };
}

function buildStats(runId, enabledSources) {
  return {
    runId,
    sourcesAttempted: enabledSources.length,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    fetched: 0,
    eligible: 0,
    inserted: 0,
    duplicates: 0,
    sourceErrors: [],
  };
}

async function collectCandidates({
  sources,
  collector,
  repository,
  days = 30,
  limit = 100,
  perSourceLimit = 20,
  minScore = 20,
  triggerType = 'manual',
  now = new Date(),
}) {
  const enabledSources = sources.filter((source) => source.enabled !== false);
  const sourceMap = await repository.syncSources(enabledSources);
  const runId = await repository.createRun({ triggerType, runMode: 'collect' });
  const stats = buildStats(runId, enabledSources);
  const cutoffTime = now.getTime() - Math.max(1, days) * 86_400_000;
  const collected = [];

  for (const source of enabledSources) {
    try {
      const entries = await collector(source);
      stats.sourcesSucceeded += 1;
      stats.fetched += entries.length;

      const normalizedEntries = entries
        .map((entry) => normalizeEntry(entry, source, now, cutoffTime, minScore))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || Date.parse(right.sourcePublishedAt) - Date.parse(left.sourcePublishedAt))
        .slice(0, perSourceLimit);

      collected.push(...normalizedEntries);
    } catch (error) {
      stats.sourcesFailed += 1;
      stats.sourceErrors.push({
        sourceKey: source.sourceKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (stats.sourcesSucceeded === 0) {
    const error = new Error('All feed sources failed');
    await repository.finishRun(runId, {
      status: 'failed',
      stats,
      errorMessage: error.message,
    });
    throw error;
  }

  const selected = collected
    .sort((left, right) => right.score - left.score || Date.parse(right.sourcePublishedAt) - Date.parse(left.sourcePublishedAt))
    .slice(0, Math.max(1, limit));
  stats.eligible = selected.length;

  const candidatesBySource = new Map();
  for (const candidate of selected) {
    const candidates = candidatesBySource.get(candidate.sourceKey) || [];
    candidates.push(candidate);
    candidatesBySource.set(candidate.sourceKey, candidates);
  }

  for (const [sourceKey, candidates] of candidatesBySource.entries()) {
    const sourceRecord = sourceMap.get(sourceKey);
    if (!sourceRecord?.id) {
      throw new Error(`Missing persisted source id for ${sourceKey}`);
    }
    const result = await repository.upsertCandidates(sourceRecord.id, runId, candidates);
    stats.inserted += result.inserted;
    stats.duplicates += result.duplicates;
  }

  await repository.finishRun(runId, {
    status: 'succeeded',
    stats,
  });
  return stats;
}

module.exports = {
  collectCandidates,
  createContentHash,
};
