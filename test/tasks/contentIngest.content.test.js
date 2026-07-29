const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { buildArticleContent, buildArticleTitle } = require('@/ingest/domain/buildArticleContent');

function buildCandidate(overrides = {}) {
  return {
    canonicalUrl: 'https://example.com/original?id=7',
    titleOriginal: 'Original AI research title',
    titleZh: '新的人工智能研究',
    summaryZh: '这项研究介绍了新的人工智能推理方法。',
    recommendation: '适合希望了解模型推理优化的开发者阅读。',
    sourceName: 'Example Research',
    sourcePublishedAt: '2026-07-24T01:00:00.000Z',
    ...overrides,
  };
}

test('buildArticleTitle prefers Chinese title and truncates to the database limit', () => {
  assert.equal(buildArticleTitle(buildCandidate()), '新的人工智能研究');
  assert.equal(buildArticleTitle(buildCandidate({ titleZh: '人'.repeat(70) })).length, 50);
  assert.equal(buildArticleTitle(buildCandidate({ titleZh: '', titleOriginal: 'Fallback title' })), 'Fallback title');
});

test('buildArticleContent produces CoderX Tiptap JSON with summary, recommendation and source link', () => {
  const content = buildArticleContent(buildCandidate());

  assert.equal(content.type, 'doc');
  assert.deepEqual(
    content.content.filter((node) => node.type === 'heading').map((node) => node.content[0].text),
    ['摘要', '为什么值得阅读', '来源'],
  );

  const linkedText = content.content.flatMap((node) => node.content || []).find((node) => node.type === 'text' && node.marks?.some((mark) => mark.type === 'link'));
  assert.equal(linkedText.text, '阅读原文 ↗');
  assert.deepEqual(linkedText.marks, [
    {
      type: 'link',
      attrs: {
        href: 'https://example.com/original?id=7',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    },
  ]);
});

test('buildArticleContent rejects candidates without enriched Chinese fields or a safe source URL', () => {
  assert.throws(() => buildArticleContent(buildCandidate({ summaryZh: '' })), /summaryZh is required/);
  assert.throws(() => buildArticleContent(buildCandidate({ canonicalUrl: 'javascript:alert(1)' })), /canonicalUrl must be an HTTP URL/);
});
