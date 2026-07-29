const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createOllamaEnricher } = require('@/ingest/enrichment/createOllamaEnricher');
const { enrichCandidates } = require('@/ingest/pipeline/enrichCandidates');

function buildCandidate(overrides = {}) {
  return {
    id: 31,
    canonicalUrl: 'https://example.com/article',
    titleOriginal: 'New agent inference model',
    summaryOriginal: 'A new LLM agent improves inference efficiency.',
    sourceName: 'Example AI',
    sourcePublishedAt: '2026-07-24T01:00:00.000Z',
    ...overrides,
  };
}

test('createOllamaEnricher validates and normalizes structured model output', async () => {
  let request;
  const enricher = createOllamaEnricher({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    generateTextImpl: async (options) => {
      request = options;
      return {
        output: {
          titleZh: '  智能体推理模型取得新进展  ',
          summaryZh: ' 新模型改善了大语言模型智能体的推理效率。 ',
          recommendation: ' 适合关注智能体工程与推理优化的开发者。 ',
          keywords: ['智能体', '推理', 'LLM'],
        },
      };
    },
  });

  const result = await enricher.enrich(buildCandidate());

  assert.deepEqual(result, {
    titleZh: '智能体推理模型取得新进展',
    summaryZh: '新模型改善了大语言模型智能体的推理效率。',
    recommendation: '适合关注智能体工程与推理优化的开发者。',
    keywords: ['智能体', '推理', 'LLM'],
  });
  assert.match(request.system, /中文科技内容编辑/);
  assert.match(request.prompt, /New agent inference model/);
  assert.equal(request.maxTokens, 800);
});

test('createOllamaEnricher rejects incomplete model output', async () => {
  const enricher = createOllamaEnricher({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    generateTextImpl: async () => ({
      output: {
        titleZh: '',
        summaryZh: '摘要',
        recommendation: '推荐理由',
        keywords: [],
      },
    }),
  });

  await assert.rejects(() => enricher.enrich(buildCandidate()), /too_small|expected string to have/i);
});

test('enrichCandidates saves valid Tiptap content and reports per-candidate failures without publishing', async () => {
  const saved = [];
  const failures = [];
  const repository = {
    async listCandidates() {
      return [buildCandidate(), buildCandidate({ id: 32, titleOriginal: 'Broken entry' })];
    },
    async saveEnrichment(id, input) {
      saved.push({ id, input });
    },
    async recordEnrichmentFailure(id, message) {
      failures.push({ id, message });
    },
  };
  const enricher = {
    async enrich(candidate) {
      if (candidate.id === 32) throw new Error('model unavailable');
      return {
        titleZh: '智能体推理模型取得新进展',
        summaryZh: '新模型改善了智能体的推理效率。',
        recommendation: '适合关注智能体工程的开发者。',
        keywords: ['智能体', '推理'],
      };
    },
  };

  const result = await enrichCandidates({ repository, enricher, limit: 10 });

  assert.deepEqual(result, { attempted: 2, enriched: 1, failed: 1 });
  assert.equal(saved[0].id, 31);
  assert.equal(saved[0].input.titleZh, '智能体推理模型取得新进展');
  assert.equal(saved[0].input.content.type, 'doc');
  assert.deepEqual(failures, [{ id: 32, message: 'model unavailable' }]);
});
