const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { backfillRichArticles } = require('@/ingest/pipeline/backfillRichArticles');

const candidates = [
  { id: 70, articleId: 143, canonicalUrl: 'https://aws.example/article', sourceName: 'AWS', sourcePublishedAt: '2026-07-24T00:00:00.000Z' },
  { id: 21, articleId: 146, canonicalUrl: 'https://nvidia.example/article', sourceName: 'NVIDIA', sourcePublishedAt: '2026-07-20T00:00:00.000Z' },
  { id: 54, articleId: 150, canonicalUrl: 'https://github.example/article', sourceName: 'GitHub', sourcePublishedAt: '2026-07-22T00:00:00.000Z' },
  { id: 149, articleId: 151, canonicalUrl: 'https://microsoft.example/article', sourceName: 'Microsoft', sourcePublishedAt: '2026-07-21T00:00:00.000Z' },
  { id: 60, articleId: 152, canonicalUrl: 'https://google.example/article', sourceName: 'Google', sourcePublishedAt: '2026-07-22T00:00:00.000Z' },
];

function richArticle(candidate) {
  return {
    titleZh: `${candidate.sourceName} 的人工智能实践`,
    lead: '这是一段用于列表和正文开头的中文导语，说明文章将围绕真实来源材料介绍人工智能系统的工程实践与产品变化。',
    sections: [
      { heading: '背景与目标', paragraphs: ['来源材料首先说明了相关技术出现的背景，以及团队希望解决的具体产品和工程问题。'] },
      { heading: '实现方式', paragraphs: ['文章随后介绍系统采用的实现方式、关键组件和部署过程中需要关注的限制条件。'] },
      { heading: '实际影响', paragraphs: ['最后一部分讨论这些变化对开发者、企业用户和后续产品迭代可能产生的实际影响。'] },
    ],
    conclusion: '整体来看，这项实践的价值在于把模型能力转化为更稳定、更容易评估和持续维护的产品体验。',
    keywords: ['人工智能', '工程实践'],
  };
}

test('backfillRichArticles isolates per-item failures and writes only complete rich articles', async () => {
  const writes = [];
  const cleaned = [];
  const promoted = [];
  const repository = {
    async listPublishedCandidatesByIds(ids) {
      assert.deepEqual(ids, [70, 21, 54, 149, 60]);
      return candidates;
    },
    async replacePublishedArticle(input) {
      writes.push(input);
      const imageRows = input.assets.map((asset, index) => ({ ...asset, id: 700 + index }));
      const content = input.buildContent(imageRows);
      assert.equal(content.type, 'doc');
      return { articleId: input.articleId, images: imageRows, oldFilenames: [`ingest-${input.candidateId}-old.jpg`] };
    },
  };

  const result = await backfillRichArticles({
    repository,
    ids: [70, 21, 54, 149, 60],
    authorIds: [1, 2, 3, 4, 5],
    now: new Date('2026-07-25T12:00:00.000Z'),
    days: 30,
    publicBaseURL: 'http://localhost:8000',
    outputDir: '/tmp/coderx-images',
    extractor: async (candidate) => {
      if (candidate.id === 54) throw new Error('source blocked');
      return {
        title: candidate.sourceName,
        canonicalUrl: candidate.canonicalUrl,
        textContent: 'source material',
        sections: [],
        images: [{ url: `${candidate.canonicalUrl}/cover.jpg`, isCover: true }],
      };
    },
    enricher: {
      async enrich(_page, candidate) {
        return richArticle(candidate);
      },
    },
    localizeImages: async ({ candidateId }) => ({
      assets: [
        {
          filename: `ingest-${candidateId}-cover.jpg`,
          smallFilename: `ingest-${candidateId}-cover-small.jpg`,
          mimetype: 'image/jpeg',
          size: 1000,
          width: 1200,
          height: 675,
          isCover: true,
          alt: '封面',
        },
      ],
      async cleanup() {
        cleaned.push(candidateId);
      },
    }),
    promoteAssets: async (assets) => {
      promoted.push(...assets.map((asset) => asset.filename));
      return { assets, copiedPaths: assets.map((asset) => `/public/${asset.filename}`) };
    },
    deleteStoredFiles: async () => {},
  });

  assert.equal(result.attempted, 5);
  assert.equal(result.updated, 4);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [{ candidateId: 54, reason: 'source blocked' }]);
  assert.equal(writes.length, 4);
  assert.equal(new Set(writes.map((write) => write.authorId)).size, 4);
  assert.ok(writes.every((write) => write.assets.length === 1));
  assert.equal(promoted.length, 4);
  assert.deepEqual(
    cleaned.sort((left, right) => left - right),
    [21, 60, 70, 149],
  );
});

test('backfillRichArticles rejects duplicate sources and insufficient author pools before fetching', async () => {
  let extracted = false;
  const repository = {
    async listPublishedCandidatesByIds() {
      return candidates.map((candidate, index) => ({
        ...candidate,
        sourceName: index < 2 ? 'Same source' : candidate.sourceName,
      }));
    },
  };

  await assert.rejects(
    () =>
      backfillRichArticles({
        repository,
        ids: [70, 21, 54, 149, 60],
        authorIds: [1, 2, 3, 4],
        extractor: async () => {
          extracted = true;
        },
        enricher: {},
        localizeImages: async () => {},
        publicBaseURL: 'http://localhost:8000',
        outputDir: '/tmp/coderx-images',
      }),
    /one approved existing author per article/i,
  );
  assert.equal(extracted, false);
});
