const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { backfillRawArticles } = require('@/ingest/pipeline/backfillRawArticles');

const candidate = {
  id: 54,
  articleId: 150,
  status: 'published',
  sourceId: 7,
  canonicalUrl: 'https://github.blog/ai-and-ml/github-copilot/article',
  titleOriginal: 'Copilot vs. raw API access: What are you actually paying for?',
  sourceName: 'GitHub AI & ML',
  sourcePublishedAt: '2026-07-22T19:00:00.000Z',
  contentMode: 'summary',
  licenseCode: 'link-only',
};

function sourcePage(target = candidate) {
  return {
    title: target.titleOriginal,
    canonicalUrl: target.canonicalUrl,
    byline: 'Andrea Griffiths',
    publishedAt: target.sourcePublishedAt,
    textContent: '',
    sections: [
      {
        heading: target.titleOriginal,
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
    async listRawCandidatesByIds(ids) {
      assert.deepEqual(ids, [54]);
      return [candidate];
    },
    async publishRawArticle() {
      throw new Error('published candidate must not use publication');
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
    tagName: '人工智能',
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

  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.articles[0].operation, 'updated');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].title, Array.from(page.title).slice(0, 50).join(''));
  assert.equal(writes[0].excerpt, page.sections[0].paragraphs[0]);
  assert.match(JSON.stringify(writes[0].buildContent([{ ...writes[0].assets[0], id: 501 }])), /API pricing/);
  assert.doesNotMatch(JSON.stringify(writes[0].buildContent([{ ...writes[0].assets[0], id: 501 }])), /摘要|为什么值得阅读/);
  assert.deepEqual(cleaned, [54]);
});

test('backfillRawArticles publishes an unmapped pending candidate without a model call', async () => {
  const writes = [];
  const pendingCandidate = {
    ...candidate,
    id: 3,
    articleId: null,
    status: 'pending',
    sourceId: 2,
    canonicalUrl: 'https://openai.com/index/small-business-program',
    titleOriginal: 'Introducing the ChatGPT for small business program',
    sourceName: 'OpenAI News',
    sourcePublishedAt: '2026-07-28T10:00:00.000Z',
  };
  const page = sourcePage(pendingCandidate);
  const repository = {
    async listRawCandidatesByIds(ids) {
      assert.deepEqual(ids, [3]);
      return [pendingCandidate];
    },
    async publishRawArticle(input) {
      writes.push(input);
      const images = input.assets.map((asset, index) => ({ ...asset, id: 701 + index }));
      return { articleId: 601, images, oldFilenames: [] };
    },
    async replacePublishedArticle() {
      throw new Error('pending candidate must not use replacement');
    },
  };

  const result = await backfillRawArticles({
    repository,
    ids: [3],
    authorIds: [2],
    tagName: '人工智能',
    now: new Date('2026-07-29T12:00:00.000Z'),
    days: 30,
    publicBaseURL: 'http://localhost:8000',
    outputDir: '/tmp/coderx-images',
    extractor: async () => page,
    localizeImages: async () => ({
      assets: [
        {
          filename: 'ingest-3-cover.jpg',
          smallFilename: 'ingest-3-cover-small.jpg',
          mimetype: 'image/jpeg',
          size: 1000,
          width: 1200,
          height: 675,
          isCover: true,
          alt: 'Small business program',
        },
      ],
      async cleanup() {},
    }),
    promoteAssets: async (assets) => ({ assets, copiedPaths: ['/public/ingest-3-cover.jpg'] }),
    deleteStoredFiles: async () => {},
  });

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.articles[0].articleId, 601);
  assert.equal(result.articles[0].operation, 'created');
  assert.equal(writes[0].candidateId, 3);
  assert.equal(writes[0].tagName, '人工智能');
  assert.match(JSON.stringify(writes[0].buildContent([{ ...writes[0].assets[0], id: 701 }])), /Small business program|small business program/);
});

test('backfillRawArticles removes promoted files when pending publication fails', async () => {
  const removed = [];
  const pendingCandidate = {
    ...candidate,
    id: 3,
    articleId: null,
    status: 'pending',
    canonicalUrl: 'https://openai.com/index/small-business-program',
    titleOriginal: 'Introducing the ChatGPT for small business program',
    sourceName: 'OpenAI News',
  };
  const repository = {
    async listRawCandidatesByIds() {
      return [pendingCandidate];
    },
    async publishRawArticle() {
      throw new Error('candidate changed during publication');
    },
    async replacePublishedArticle() {
      throw new Error('pending candidate must not use replacement');
    },
  };

  const result = await backfillRawArticles({
    repository,
    ids: [3],
    authorIds: [2],
    tagName: '人工智能',
    publicBaseURL: 'http://localhost:8000',
    outputDir: '/tmp/coderx-images',
    extractor: async () => sourcePage(pendingCandidate),
    localizeImages: async () => ({
      assets: [
        {
          filename: 'ingest-3-cover.jpg',
          smallFilename: 'ingest-3-cover-small.jpg',
          mimetype: 'image/jpeg',
          size: 1000,
          width: 1200,
          height: 675,
          isCover: true,
        },
      ],
      async cleanup() {},
    }),
    promoteAssets: async (assets) => ({
      assets,
      copiedPaths: ['/public/ingest-3-cover.jpg', '/public/ingest-3-cover-small.jpg'],
    }),
    deleteStoredFiles: async (files) => {
      removed.push(...files);
    },
  });

  assert.equal(result.created, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(removed, ['/public/ingest-3-cover.jpg', '/public/ingest-3-cover-small.jpg']);
});

test('backfillRawArticles isolates extraction failures and validates explicit IDs', async () => {
  const repository = {
    async listRawCandidatesByIds() {
      return [candidate];
    },
    async publishRawArticle() {
      throw new Error('should not publish');
    },
    async replacePublishedArticle() {
      throw new Error('should not write');
    },
  };

  const result = await backfillRawArticles({
    repository,
    ids: [54],
    authorIds: [3],
    tagName: '人工智能',
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
        tagName: '人工智能',
        extractor: async () => sourcePage(),
        localizeImages: async () => {},
        publicBaseURL: 'http://localhost:8000',
        outputDir: '/tmp/coderx-images',
      }),
    /1–5 unique positive candidate IDs/i,
  );
});
