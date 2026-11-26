import type { Candidate } from '../ingest.types.js';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const enrichmentSchema = z.object({
  titleZh: z.string().trim().min(1).max(80),
  summaryZh: z.string().trim().min(1).max(1200),
  recommendation: z.string().trim().min(1).max(500),
  keywords: z.array(z.string().trim().min(1).max(30)).min(1).max(8),
});

function normalizeOutput(output: unknown) {
  const parsed = enrichmentSchema.parse(output);
  return {
    titleZh: parsed.titleZh.trim(),
    summaryZh: parsed.summaryZh.trim(),
    recommendation: parsed.recommendation.trim(),
    keywords: [...new Set(parsed.keywords.map((keyword) => keyword.trim()))],
  };
}

export interface EnricherOptions {
  generateTextImpl?: typeof generateText;
  model: string;
  baseURL: string;
}

function createOllamaEnricher({ generateTextImpl = generateText, model, baseURL }: EnricherOptions) {
  if (typeof generateTextImpl !== 'function') throw new Error('generateTextImpl is required');
  if (!model) throw new Error('model is required');
  if (!baseURL) throw new Error('baseURL is required');

  const ollama = createOpenAI({
    baseURL,
    apiKey: 'ollama', // pragma: allowlist secret -- Ollama ignores this SDK-required placeholder.
  });

  async function enrich(candidate: Pick<Candidate, 'sourceName' | 'titleOriginal' | 'summaryOriginal'>) {
    const request = {
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
    };
    const result = await generateTextImpl(request);

    return normalizeOutput(result.output);
  }

  return { enrich };
}

export { createOllamaEnricher };
