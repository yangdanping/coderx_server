const { createOpenAI } = require('@ai-sdk/openai');
const { generateText, Output } = require('ai');
const { z } = require('zod');

const MIN_ARTICLE_LENGTH = 800;
const MAX_ARTICLE_LENGTH = 1500;

const richArticleSchema = z.object({
  titleZh: z.string().trim().min(8).max(80),
  lead: z.string().trim().min(60).max(240),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(2).max(40),
        paragraphs: z.array(z.string().trim().min(40).max(320)).min(1).max(3),
      }),
    )
    .min(3)
    .max(6),
  conclusion: z.string().trim().min(40).max(240),
  keywords: z.array(z.string().trim().min(1).max(30)).min(2).max(8),
});

function richArticleLength(article) {
  const text = [article?.lead, ...(article?.sections || []).flatMap((section) => [section.heading, ...(section.paragraphs || [])]), article?.conclusion].filter(Boolean).join('');
  return Array.from(text.replace(/\s+/g, '')).length;
}

function normalizeRichOutput(output) {
  const parsed = richArticleSchema.parse(output);
  const normalized = {
    titleZh: parsed.titleZh.trim(),
    lead: parsed.lead.trim(),
    sections: parsed.sections.map((section) => ({
      heading: section.heading.trim(),
      paragraphs: section.paragraphs.map((paragraph) => paragraph.trim()),
    })),
    conclusion: parsed.conclusion.trim(),
    keywords: [...new Set(parsed.keywords.map((keyword) => keyword.trim()))],
  };
  const length = richArticleLength(normalized);
  if (length < MIN_ARTICLE_LENGTH || length > MAX_ARTICLE_LENGTH) {
    throw new Error(`Rich article must contain ${MIN_ARTICLE_LENGTH}–${MAX_ARTICLE_LENGTH} Chinese characters; received ${length}`);
  }
  return normalized;
}

function formatSourceMaterial(page) {
  const sections = (page.sections || []).map((section) => [`### ${section.heading || ''}`, ...(section.paragraphs || [])].join('\n')).join('\n\n');
  return [
    `原标题：${page.title || ''}`,
    `原作者：${page.byline || '未标注'}`,
    `原始发布时间：${page.publishedAt || '未标注'}`,
    `原文链接：${page.canonicalUrl || ''}`,
    '',
    sections || page.textContent || '',
  ]
    .join('\n')
    .slice(0, 18_000);
}

function createRichArticleEnricher({ generateTextImpl = generateText, model, baseURL }) {
  if (typeof generateTextImpl !== 'function') throw new Error('generateTextImpl is required');
  if (!model) throw new Error('model is required');
  if (!baseURL) throw new Error('baseURL is required');

  const ollama = createOpenAI({
    baseURL,
    apiKey: 'ollama', // pragma: allowlist secret -- Ollama ignores this SDK-required placeholder.
  });

  return {
    async enrich(page) {
      const result = await generateTextImpl({
        model: ollama.chat(model),
        system: [
          '你是一名严谨的中文科技编辑。',
          '根据提供的公开来源材料重新组织一篇自然、连贯的中文文章，不逐句翻译，不复制大段原文。',
          '不得补充来源中没有出现的人名、数字、地点、因果关系或个人经历。',
          '文章正文必须为 800–1500 个中文字符，包含 3–6 个有信息量的章节。',
        ].join(''),
        prompt: ['只允许使用以下来源材料：', '', formatSourceMaterial(page), '', '输出简洁标题、导语、章节、结语和关键词。'].join('\n'),
        output: Output.object({ schema: richArticleSchema }),
        maxTokens: 3000,
      });
      return normalizeRichOutput(result.output);
    },
  };
}

module.exports = {
  createRichArticleEnricher,
  normalizeRichOutput,
  richArticleLength,
  richArticleSchema,
};
