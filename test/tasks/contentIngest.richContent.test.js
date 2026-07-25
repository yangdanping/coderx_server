const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createRichArticleEnricher, richArticleLength } = require('@/ingest/enrichment/createRichArticleEnricher');
const { buildRichArticleContent } = require('@/ingest/domain/buildRichArticleContent');

const paragraphA =
  '企业在部署人工智能系统时，不能只关注模型在单一基准上的得分，还需要同时观察数据质量、响应延迟、工具调用和真实用户任务的完成情况。只有把离线评测与线上样本结合起来，团队才能发现测试集没有覆盖的边界问题，并为每次模型升级建立可以重复比较的质量基线。';
const paragraphB =
  '稳定的生产系统需要为外部工具不可用、输入材料不完整和请求超过限额等情况准备明确的降级路径。每次降级都应说明原因、限制重试次数，并把关键事件写入可检索的监控记录。这样既能控制故障影响范围，也能让工程人员快速定位真正的瓶颈。';
const paragraphC =
  '人工审核最适合集中在不确定或影响较大的决策上，而不是机械检查每一次普通响应。系统可以利用置信信号、规则检查和抽样策略，把高风险案例交给审核人员，并将审核结果沉淀为新的评测样本，使质量控制随着实际使用持续改进。';
const paragraphD =
  '监控范围应覆盖模型输出、检索结果、工具执行、成本和端到端耗时，单一平均指标通常无法解释用户感受到的问题。把用户侧症状与具体组件关联起来，再配合灰度发布和快速回滚机制，才能让频繁变化的模型与依赖保持可控。';
const paragraphE =
  '从长期看，人工智能功能应被当作持续运营的软件系统。模型会更新，数据会漂移，第三方接口也可能改变行为。清晰的组件契约、版本记录和定期回归评测，可以让团队在迭代速度与可靠性之间建立稳定平衡，而不是每次发布都重新冒险。';
const paragraphF =
  '这套方法的重点不是增加流程数量，而是让每个关键决定都拥有可观察的证据。产品、算法和工程团队共享同一组任务指标后，能够更快判断问题来自内容、模型还是集成层，并把有限资源投入到真正影响使用体验的环节。持续记录决策依据，也能让后续维护者理解当时的取舍。';

function buildRichOutput(overrides = {}) {
  return {
    titleZh: '从评测到监控：如何构建可靠的生产级人工智能系统',
    lead: '人工智能应用进入生产环境后，真正决定体验的往往不是一次演示中的模型能力，而是评测、降级、人工审核与持续监控能否形成完整闭环。',
    sections: [
      { heading: '用真实任务建立评测基线', paragraphs: [paragraphA, paragraphF] },
      { heading: '为失败和降级预留空间', paragraphs: [paragraphB, paragraphC] },
      { heading: '用全链路监控支撑迭代', paragraphs: [paragraphD, paragraphE] },
    ],
    conclusion: '当评测证据、运行边界和反馈机制同时到位时，团队才能把快速变化的模型变成可维护、可解释并能够长期改进的产品能力。',
    keywords: ['人工智能', '生产系统', '模型评测', '可观测性'],
    ...overrides,
  };
}

function buildSourcePage() {
  return {
    title: 'Practical AI Systems in Production',
    canonicalUrl: 'https://news.example/posts/ai-systems',
    byline: 'Example Research Team',
    publishedAt: '2026-07-20T09:30:00.000Z',
    textContent: [paragraphA, paragraphB, paragraphC, paragraphD, paragraphE, paragraphF].join('\n\n'),
    sections: [
      { heading: 'Evaluation', paragraphs: [paragraphA, paragraphF] },
      { heading: 'Failure modes', paragraphs: [paragraphB, paragraphC] },
      { heading: 'Operations', paragraphs: [paragraphD, paragraphE] },
    ],
  };
}

test('createRichArticleEnricher validates an 800–1500 character structured rewrite', async () => {
  let request;
  const enricher = createRichArticleEnricher({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    generateTextImpl: async (input) => {
      request = input;
      return { output: buildRichOutput() };
    },
  });

  const result = await enricher.enrich(buildSourcePage());

  assert.equal(result.sections.length, 3);
  assert.ok(richArticleLength(result) >= 800);
  assert.ok(richArticleLength(result) <= 1500);
  assert.match(request.prompt, /Practical AI Systems in Production/);
  assert.match(request.prompt, /只允许使用以下来源材料/);
});

test('createRichArticleEnricher rejects rewrites that are too short or structurally incomplete', async () => {
  let generationCount = 0;
  const shortEnricher = createRichArticleEnricher({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    generateTextImpl: async () => {
      generationCount += 1;
      if (generationCount === 3) {
        return {
          output: {
            heading: '补充内容',
            paragraph: '这段补充严格基于来源材料，但原始草稿的信息量过低，即使补足一个完整段落也无法达到发布所需的正文长度。'.repeat(6),
          },
        };
      }
      return {
        output: buildRichOutput({
        lead: '这是一个长度足够通过字段校验、但整体内容仍明显不足的简短导语，用来验证总长度门槛能够在基础结构正确时继续阻止过短文章进入后续流程。',
        sections: [
          { heading: '第一部分', paragraphs: [paragraphA] },
          { heading: '第二部分', paragraphs: [paragraphB] },
          { heading: '第三部分', paragraphs: [paragraphC] },
        ],
        conclusion: '这段结语已经达到字段规定的最低长度要求，但不会让整篇文章因此达到八百字的完整质量门槛。',
        }),
      };
    },
  });

  await assert.rejects(() => shortEnricher.enrich(buildSourcePage()), /800–1500/);
});

test('createRichArticleEnricher retries once when the first structured rewrite is too short', async () => {
  const requests = [];
  const shortDraft = buildRichOutput({
    lead: '这是一个长度足够通过字段校验、但整体内容仍明显不足的简短导语，用来验证总长度门槛能够在基础结构正确时触发一次有边界的自动修订。',
    sections: [
      { heading: '第一部分', paragraphs: [paragraphA] },
      { heading: '第二部分', paragraphs: [paragraphB] },
      { heading: '第三部分', paragraphs: [paragraphC] },
    ],
    conclusion: '这段结语已经达到字段规定的最低长度要求，但不会让整篇文章因此达到八百字的完整质量门槛。',
  });
  const enricher = createRichArticleEnricher({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    generateTextImpl: async (input) => {
      requests.push(input);
      return { output: requests.length === 1 ? shortDraft : buildRichOutput() };
    },
  });

  const result = await enricher.enrich(buildSourcePage());

  assert.equal(requests.length, 2);
  assert.ok(richArticleLength(result) >= 800);
  assert.match(requests[1].prompt, /上一版草稿|950–1200/);
});

test('createRichArticleEnricher adds one grounded supplement when the revised draft is still short', async () => {
  const requests = [];
  const nearCompleteDraft = buildRichOutput({
    sections: [
      { heading: '第一部分', paragraphs: [paragraphA, paragraphD] },
      { heading: '第二部分', paragraphs: [paragraphB, paragraphE] },
      { heading: '第三部分', paragraphs: [paragraphC] },
    ],
  });
  const supplement = `${paragraphF}因此，补充内容仍然围绕来源材料中的工程实践展开，并且不会引入未经来源支持的新事实或结论。`;
  assert.ok(richArticleLength(nearCompleteDraft) < 800);

  const enricher = createRichArticleEnricher({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    generateTextImpl: async (input) => {
      requests.push(input);
      if (requests.length < 3) return { output: nearCompleteDraft };
      return { output: { heading: '补充观察', paragraph: supplement } };
    },
  });

  const result = await enricher.enrich(buildSourcePage());

  assert.equal(requests.length, 3);
  assert.ok(richArticleLength(result) >= 800);
  assert.match(requests[2].prompt, /补充一个信息段|不得重复已有段落/);
});

test('buildRichArticleContent renders headings, local images and source disclosure', () => {
  const article = buildRichOutput();
  const doc = buildRichArticleContent({
    article,
    source: {
      name: 'Example Research',
      canonicalUrl: 'https://news.example/posts/ai-systems',
      publishedAt: '2026-07-20T09:30:00.000Z',
    },
    images: [
      { id: 501, src: 'http://localhost:8000/article/images/cover.jpg', alt: '系统架构封面', isCover: true },
      { id: 502, src: 'http://localhost:8000/article/images/evaluation.jpg', alt: '评测结果' },
      { id: 503, src: 'http://localhost:8000/article/images/monitoring.jpg', alt: '监控面板' },
    ],
  });

  assert.equal(doc.type, 'doc');
  assert.deepEqual(
    doc.content.filter((node) => node.type === 'heading').map((node) => node.content[0].text),
    article.sections.map((section) => section.heading),
  );
  assert.deepEqual(
    doc.content.filter((node) => node.type === 'image').map((node) => node.attrs.imageId),
    [501, 502, 503],
  );

  const textNodes = doc.content.flatMap((node) => node.content || []).filter((node) => node.type === 'text');
  assert.ok(textNodes.some((node) => /基于公开来源整理/.test(node.text)));
  const sourceLink = textNodes.find((node) => node.marks?.some((mark) => mark.type === 'link'));
  assert.equal(sourceLink.marks[0].attrs.href, 'https://news.example/posts/ai-systems');
});
