import type { Candidate } from '../ingest.types.js';

function requireText(value: unknown, fieldName: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}

function buildArticleTitle(candidate: Partial<Pick<Candidate, 'titleZh' | 'titleOriginal'>>) {
  const title = requireText(candidate.titleZh || candidate.titleOriginal, 'title');
  return Array.from(title).slice(0, 50).join('');
}

function heading(text: string) {
  return {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text: string) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

function validateHttpUrl(value: string) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('canonicalUrl must be an HTTP URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('canonicalUrl must be an HTTP URL');
  }

  return url.toString();
}

function formatSource(candidate: Pick<Candidate, 'sourceName' | 'sourcePublishedAt'>) {
  const sourceName = requireText(candidate.sourceName, 'sourceName');
  if (!candidate.sourcePublishedAt) return sourceName;

  const publishedAt = new Date(candidate.sourcePublishedAt);
  if (Number.isNaN(publishedAt.getTime())) return sourceName;

  return `${sourceName} · ${publishedAt.toISOString().slice(0, 10)}`;
}

function buildArticleContent(candidate: Pick<Candidate, 'sourceName' | 'sourcePublishedAt' | 'canonicalUrl' | 'summaryZh' | 'recommendation'>) {
  const summaryZh = requireText(candidate.summaryZh, 'summaryZh');
  const recommendation = requireText(candidate.recommendation, 'recommendation');
  const canonicalUrl = validateHttpUrl(candidate.canonicalUrl);

  return {
    type: 'doc',
    content: [
      heading('摘要'),
      paragraph(summaryZh),
      heading('为什么值得阅读'),
      paragraph(recommendation),
      heading('来源'),
      paragraph(formatSource(candidate)),
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '阅读原文 ↗',
            marks: [
              {
                type: 'link',
                attrs: {
                  href: canonicalUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export { buildArticleContent, buildArticleTitle };
