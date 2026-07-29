const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { isPlaceholderArticle } = require('@/ingest/domain/isPlaceholderArticle');
const { purgePlaceholderArticles } = require('@/ingest/pipeline/purgePlaceholderArticles');

function heading(text) {
  return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] };
}

function paragraph(text, marks) {
  const node = { type: 'text', text };
  if (marks) node.marks = marks;
  return { type: 'paragraph', content: [node] };
}

function placeholderContent() {
  return {
    type: 'doc',
    content: [
      heading('摘要'),
      paragraph('简短摘要。'),
      heading('为什么值得阅读'),
      paragraph('简短推荐。'),
      heading('来源'),
      paragraph('OpenAI News · 2026-07-22'),
      paragraph('阅读原文 ↗', [{ type: 'link', attrs: { href: 'https://example.com/article' } }]),
    ],
  };
}

test('isPlaceholderArticle matches only the exact fixed-format Tiptap signature', () => {
  assert.equal(isPlaceholderArticle(placeholderContent()), true);
  assert.equal(
    isPlaceholderArticle({
      type: 'doc',
      content: [paragraph('Full article introduction.'), heading('Source'), paragraph('Original source.')],
    }),
    false,
  );
  assert.equal(isPlaceholderArticle({ ...placeholderContent(), content: placeholderContent().content.filter((node) => node.content?.[0]?.text !== '为什么值得阅读') }), false);
  assert.equal(
    isPlaceholderArticle({
      ...placeholderContent(),
      content: placeholderContent().content.map((node) =>
        node.content?.[0]?.text === '阅读原文 ↗' ? paragraph('阅读原文 ↗') : node,
      ),
    }),
    false,
  );
});

test('purgePlaceholderArticles returns a complete manifest without mutation by default', async () => {
  let deleted = false;
  const manifest = [
    {
      articleId: 144,
      candidateId: 71,
      title: 'Placeholder',
      canonicalUrl: 'https://example.com/article',
      sourceName: 'Example',
      content: placeholderContent(),
      filenames: [],
    },
  ];
  const result = await purgePlaceholderArticles({
    repository: {
      async listPlaceholderArticles() {
        return manifest;
      },
      async deletePlaceholderArticles() {
        deleted = true;
        return manifest;
      },
    },
    apply: false,
  });

  assert.equal(deleted, false);
  assert.deepEqual(result, { matched: 1, deleted: 0, manifest });
});

test('purgePlaceholderArticles applies the exact manifest through the repository', async () => {
  const manifest = [
    {
      articleId: 144,
      candidateId: 71,
      title: 'Placeholder',
      canonicalUrl: 'https://example.com/article',
      sourceName: 'Example',
      content: placeholderContent(),
      filenames: [],
    },
  ];
  const deletedIds = [];
  const result = await purgePlaceholderArticles({
    repository: {
      async listPlaceholderArticles() {
        return manifest;
      },
      async deletePlaceholderArticles(ids) {
        deletedIds.push(...ids);
        return manifest;
      },
    },
    apply: true,
  });

  assert.deepEqual(deletedIds, [144]);
  assert.deepEqual(result, { matched: 1, deleted: 1, manifest });
});
