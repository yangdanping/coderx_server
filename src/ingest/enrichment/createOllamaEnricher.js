const { createOpenAI } = require('@ai-sdk/openai');
const { generateText, Output } = require('ai');
const { z } = require('zod');

const enrichmentSchema = z.object({
  titleZh: z.string().trim().min(1).max(80),
  summaryZh: z.string().trim().min(1).max(1200),
  recommendation: z.string().trim().min(1).max(500),
  keywords: z.array(z.string().trim().min(1).max(30)).min(1).max(8),
});

function normalizeOutput(output) {
  const parsed = enrichmentSchema.parse(output);
  return {
    titleZh: parsed.titleZh.trim(),
    summaryZh: parsed.summaryZh.trim(),
    recommendation: parsed.recommendation.trim(),
    keywords: [...new Set(parsed.keywords.map((keyword) => keyword.trim()))],
  };
}

function createOllamaEnricher({ generateTextImpl = generateText, model, baseURL }) {
  if (typeof generateTextImpl !== 'function') throw new Error('generateTextImpl is required');
  if (!model) throw new Error('model is required');
  if (!baseURL) throw new Error('baseURL is required');

  const ollama = createOpenAI({
    baseURL,
    apiKey: 'ollama', // pragma: allowlist secret -- Ollama ignores this SDK-required placeholder.
  });

  async function enrich(candidate) {
    const result = await generateTextImpl({
      model: ollama.chat(model),
      system: '你是一名严谨的中文科技内容编辑。忠实概括来源材料，不虚构事实，不复制大段原文，只输出指定结构化字段。',
      prompt: [
        `来源：${candidate.sourceName || '未知来源'}`,
        `原标题：${candidate.titleOriginal || ''}`,
        `原摘要：${candidate.summaryOriginal || ''}`,
        '',
        '请生成简洁的中文标题、中文摘要、推荐理由和 1–8 个关键词。',
      ].join('\n'),
      output: Output.object({ schema: enrichmentSchema }),
      maxTokens: 800,
    });

    return normalizeOutput(result.output);
  }

  return { enrich };
}

module.exports = {
  createOllamaEnricher,
};
