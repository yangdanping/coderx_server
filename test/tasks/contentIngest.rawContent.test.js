const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { buildRawArticleContent, rawArticleExcerpt } = require('@/ingest/domain/buildRawArticleContent');

function sourcePage() {
  return {
    title: 'Copilot vs. raw API access: What are you actually paying for?',
    canonicalUrl: 'https://github.blog/ai-and-ml/github-copilot/copilot-vs-raw-api-access-what-are-you-actually-paying-for/',
    byline: 'Andrea Griffiths',
    publishedAt: '2026-07-22T19:00:00.000Z',
    textContent: '',
    sections: [
      {
        heading: 'Copilot vs. raw API access: What are you actually paying for?',
        paragraphs: [
          'Model access is only one part of the cost of an AI coding workflow. Teams also need context assembly, tool execution, policy controls, and a dependable interface.',
        ],
      },
      {
        heading: 'API pricing',
        paragraphs: [
          'Direct API access gives engineering teams control over prompts, model selection, and token usage, but the surrounding workflow remains their responsibility.',
        ],
      },
      {
        heading: 'Workflow value',
        paragraphs: [
          'A coding assistant packages model access with repository context, editing tools, execution loops, and feedback that developers can use without building a harness first.',
        ],
      },
      {
        heading: 'Policy controls',
        paragraphs: [
          'Organization-level controls add governance, access management, and usage visibility around the underlying model requests.',
        ],
      },
    ],
  };
}

test('buildRawArticleContent preserves source headings and paragraphs with local images', () => {
  const page = sourcePage();
  const doc = buildRawArticleContent({
    page,
    source: {
      name: 'GitHub AI & ML',
      canonicalUrl: page.canonicalUrl,
      publishedAt: page.publishedAt,
    },
    images: [
      { id: 501, src: 'http://localhost:8000/article/images/cover.jpg', alt: 'Copilot cover', isCover: true },
      { id: 502, src: 'http://localhost:8000/article/images/workflow.jpg', alt: 'Workflow diagram' },
      { id: 503, src: 'http://localhost:8000/article/images/policy.jpg', alt: 'Policy controls' },
    ],
  });

  assert.equal(doc.type, 'doc');
  assert.deepEqual(
    doc.content.filter((node) => node.type === 'heading').map((node) => node.content[0].text),
    ['API pricing', 'Workflow value', 'Policy controls', 'Source'],
  );
  assert.deepEqual(
    doc.content.filter((node) => node.type === 'image').map((node) => node.attrs.imageId),
    [501, 502, 503],
  );
  const serialized = JSON.stringify(doc);
  assert.match(serialized, /Model access is only one part of the cost/);
  assert.match(serialized, /GitHub AI & ML · Andrea Griffiths · 2026-07-22/);
  assert.match(serialized, /Read the original article ↗/);
  assert.doesNotMatch(serialized, /摘要|为什么值得阅读/);
});

test('rawArticleExcerpt returns the first source paragraph with a Unicode-safe limit', () => {
  const page = sourcePage();
  page.sections[0].paragraphs[0] = '🚀'.repeat(260);

  const excerpt = rawArticleExcerpt(page);

  assert.equal(Array.from(excerpt).length, 240);
  assert.equal(excerpt, '🚀'.repeat(240));
});

test('buildRawArticleContent rejects missing source material, images and unsafe links', () => {
  const page = sourcePage();
  const source = { name: 'GitHub AI & ML', canonicalUrl: page.canonicalUrl };
  const images = [{ id: 501, src: 'http://localhost:8000/article/images/cover.jpg', isCover: true }];

  assert.throws(() => buildRawArticleContent({ page: { ...page, sections: [] }, source, images }), /source sections/i);
  assert.throws(() => buildRawArticleContent({ page, source, images: [] }), /localized image/i);
  assert.throws(() => buildRawArticleContent({ page, source: { ...source, canonicalUrl: 'file:///etc/passwd' }, images }), /HTTP URL/i);
});
