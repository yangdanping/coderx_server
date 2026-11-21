import type { createOllamaEnricher } from '../enrichment/createOllamaEnricher.js';
import type { IngestRepository } from '../repositories/ingestRepository.js';
import { buildArticleContent, buildArticleTitle } from '../domain/buildArticleContent.js';

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function enrichCandidates({
  repository,
  enricher,
  limit = 60,
}: {
  repository: Pick<IngestRepository, 'listCandidates' | 'saveEnrichment' | 'recordEnrichmentFailure'>;
  enricher: ReturnType<typeof createOllamaEnricher>;
  limit?: number;
}) {
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

export { enrichCandidates };
