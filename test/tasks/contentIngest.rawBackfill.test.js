const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { backfillRawArticles } = require('@/ingest/pipeline/backfillRawArticles');

const candidate = {
  id: 54,
  articleId: 150,
  canonicalUrl: 'https://github.blog/ai-and-ml/github-copilot/article',
  sourceName: 'GitHub AI & ML',
  sourcePublishedAt: '2026-07-22T19:00:00.000Z',
};

function sourcePage() {
  return {
    title: 'Copilot vs. raw API access: What are you actually paying for?',
    canonicalUrl: candidate.canonicalUrl,
    byline: 'Andrea Griffiths',
    publishedAt: candidate.sourcePublishedAt,
    textContent: '',
    sections: [
      {
        heading: 'Copilot vs. raw API access: What are you actually paying for?',
        paragraphs: ['Model access is only one part of the cost of an AI coding workflow. Teams also need context assembly and dependable tools.'],
      },
      {
        heading: 'API pricing',
        paragraphs: ['Direct API access gives teams control over prompts and token usage, while the surrounding workflow remains their responsibility.'],
      },
    ],
    images: [{ url: 'https://github.blog/cover.webp', alt: 'Copilot cover', isCover: true }],
  };
}

test('backfillRawArticles replaces a mapped article without a model call', async () => {
  const writes = [];
  const cleaned = [];
  const page = sourcePage();
  const repository = {
    async listPublishedCandidatesByIds(ids) {
      assert.deepEqual(ids, [54]);
      return [candidate];
    },
    async replacePublishedArticle(input) {
      writes.push(input);
      const imageRows = input.assets.map((asset, index) => ({ ...asset, id: 501 + index }));
      return {
        articleId: input.articleId,
        images: imageRows,
        oldFilenames: ['ingest-54-old.jpg'],
        content: input.buildContent(imageRows),
      };
    },
  };

  const result = await backfillRawArticles({
    repository,
    ids: [54],
    authorIds: [3],
    now: new Date('2026-07-25T12:00:00.000Z'),
    days: 30,
    publicBaseURL: 'http://localhost:8000',
    outputDir: '/tmp/coderx-images',
    extractor: async () => page,
    localizeImages: async () => ({
      assets: [
        {
          filename: 'ingest-54-cover.jpg',
          smallFilename: 'ingest-54-cover-small.jpg',
          mimetype: 'image/jpeg',
          size: 1000,
          width: 1200,
          height: 675,
          isCover: true,
          alt: 'Copilot cover',
        },
      ],
      async cleanup() {
        cleaned.push(54);
      },
    }),
    promoteAssets: async (assets) => ({ assets, copiedPaths: ['/public/ingest-54-cover.jpg'] }),
    deleteStoredFiles: async () => {},
  });

  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].title, Array.from(page.title).slice(0, 50).join(''));
  assert.equal(writes[0].excerpt, page.sections[0].paragraphs[0]);
  assert.match(JSON.stringify(writes[0].buildContent([{ ...writes[0].assets[0], id: 501 }])), /API pricing/);
  assert.doesNotMatch(JSON.stringify(writes[0].buildContent([{ ...writes[0].assets[0], id: 501 }])), /摘要|为什么值得阅读/);
  assert.deepEqual(cleaned, [54]);
});

test('backfillRawArticles isolates extraction failures and validates explicit IDs', async () => {
  const repository = {
    async listPublishedCandidatesByIds() {
      return [candidate];
    },
    async replacePublishedArticle() {
      throw new Error('should not write');
    },
  };

  const result = await backfillRawArticles({
    repository,
    ids: [54],
    authorIds: [3],
    publicBaseURL: 'http://localhost:8000',
    outputDir: '/tmp/coderx-images',
    extractor: async () => {
      throw new Error('source unavailable');
    },
    localizeImages: async () => {
      throw new Error('should not localize');
    },
  });

  assert.deepEqual(result.failures, [{ candidateId: 54, reason: 'source unavailable' }]);
  await assert.rejects(
    () =>
      backfillRawArticles({
        repository,
        ids: [54, 54],
        authorIds: [1, 2],
        extractor: async () => sourcePage(),
        localizeImages: async () => {},
        publicBaseURL: 'http://localhost:8000',
        outputDir: '/tmp/coderx-images',
      }),
    /1–5 unique positive candidate IDs/i,
  );
});
