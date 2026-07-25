const { buildArticleContent, buildArticleTitle } = require('@/ingest/domain/buildArticleContent');

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function enrichCandidates({ repository, enricher, limit = 60 }) {
  const candidates = await repository.listCandidates({
    statuses: ['pending'],
    limit,
  });
  const stats = {
    attempted: candidates.length,
    enriched: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const enriched = await enricher.enrich(candidate);
      const enrichedCandidate = { ...candidate, ...enriched };
      await repository.saveEnrichment(candidate.id, {
        ...enriched,
        titleZh: buildArticleTitle(enrichedCandidate),
        content: buildArticleContent(enrichedCandidate),
      });
      stats.enriched += 1;
    } catch (error) {
      await repository.recordEnrichmentFailure(candidate.id, errorMessage(error));
      stats.failed += 1;
    }
  }

  return stats;
}

module.exports = {
  enrichCandidates,
};
