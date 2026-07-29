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

function appendSupplement(output, supplement) {
  const repaired = richArticleSchema.parse(structuredClone(output));
  const targetSection = [...repaired.sections].reverse().find((section) => section.paragraphs.length < 3);

  if (targetSection) {
    targetSection.paragraphs.push(supplement.paragraph.trim());
  } else if (repaired.sections.length < 6) {
    repaired.sections.push({
      heading: supplement.heading.trim(),
      paragraphs: [supplement.paragraph.trim()],
    });
  } else {
    throw new Error('Rich article has no section capacity for a supplement');
  }

  return normalizeRichOutput(repaired);
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
    .slice(0, 9_000);
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
      const sourceMaterial = formatSourceMaterial(page);
      let previousOutput = null;
      let previousError = null;
      let finalShortOutput = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const revisionPrompt = previousOutput
          ? [
              '',
              '上一版草稿：',
              JSON.stringify(previousOutput),
              '',
              `上一版未通过原因：${previousError}`,
              '请在不增加来源外事实的前提下修订，目标为 950–1200 个中文字符。每个章节应有充分展开的段落，但不要重复凑字。',
            ].join('\n')
          : '';
        const result = await generateTextImpl({
          model: ollama.chat(model),
          system: [
            '你是一名严谨的中文科技编辑。',
            '根据提供的公开来源材料重新组织一篇自然、连贯的中文文章，不逐句翻译，不复制大段原文。',
            '不得补充来源中没有出现的人名、数字、地点、因果关系或个人经历。',
            '正文目标为 950–1200 个中文字符，必须落在 800–1500 字范围内；使用 3–6 个有信息量的章节，每章尽量包含两个完整段落。',
          ].join(''),
          prompt: [
            '只允许使用以下来源材料：',
            '',
            previousOutput ? sourceMaterial.slice(0, 4_500) : sourceMaterial,
            revisionPrompt,
            '',
            '输出简洁标题、导语、章节、结语和关键词。',
          ].join('\n'),
          output: Output.object({ schema: richArticleSchema }),
          maxTokens: 1800,
        });

        try {
          return normalizeRichOutput(result.output);
        } catch (error) {
          if (attempt === 1) {
            finalShortOutput = result.output;
            previousError = error.message;
            break;
          }
          previousOutput = result.output;
          previousError = error.message;
        }
      }

      const parsedShortOutput = richArticleSchema.parse(finalShortOutput);
      const shortLength = richArticleLength(parsedShortOutput);
      if (shortLength >= MIN_ARTICLE_LENGTH || !/800–1500/.test(previousError || '')) {
        throw new Error(previousError || 'Rich article generation failed');
      }

      const minimumSupplementLength = Math.min(280, Math.max(100, MIN_ARTICLE_LENGTH - shortLength + 30));
      const maximumSupplementLength = Math.min(320, MAX_ARTICLE_LENGTH - shortLength);
      const supplementSchema = z.object({
        heading: z.string().trim().min(2).max(40),
        paragraph: z.string().trim().min(minimumSupplementLength).max(maximumSupplementLength),
      });
      const supplementResult = await generateTextImpl({
        model: ollama.chat(model),
        system: [
          '你是一名严谨的中文科技编辑。',
          '只根据来源材料和现有草稿补充缺失的信息，不增加来源中没有的人名、数字、地点、因果关系或个人经历。',
        ].join(''),
        prompt: [
          '来源材料：',
          sourceMaterial.slice(0, 3_500),
          '',
          '现有草稿：',
          JSON.stringify(finalShortOutput),
          '',
          `当前正文约 ${shortLength} 字。请补充一个信息段，段落长度为 ${minimumSupplementLength}–${maximumSupplementLength} 个中文字符；不得重复已有段落。`,
        ].join('\n'),
        output: Output.object({ schema: supplementSchema }),
        maxTokens: 600,
      });

      return appendSupplement(finalShortOutput, supplementSchema.parse(supplementResult.output));
    },
  };
}

module.exports = {
  createRichArticleEnricher,
  normalizeRichOutput,
  richArticleLength,
  richArticleSchema,
};
