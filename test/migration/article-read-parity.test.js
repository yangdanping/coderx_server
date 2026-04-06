const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parityScriptPath = path.resolve(__dirname, '../../scripts/migration/verify-article-read-parity.js');

const loadParityScript = () => {
  assert.equal(fs.existsSync(parityScriptPath), true, 'Expected article read parity script to exist');
  return require(parityScriptPath);
};

test('evaluateFlowParity normalizes equivalent MySQL JSON strings and PostgreSQL objects', () => {
  const { evaluateFlowParity } = loadParityScript();

  const report = evaluateFlowParity(
    'getDetail',
    { articleId: 42 },
    [
      {
        id: 42,
        title: 'Parity',
        author: '{"name":"alice","id":1}',
        tags: '[{"name":"pg","id":9}]',
        images: '[{"url":"https://api.example/article/images/a.png","id":3}]',
        createAt: new Date('2026-04-06T00:00:00.000Z'),
      },
    ],
    [
      {
        id: 42,
        title: 'Parity',
        author: { id: 1, name: 'alice' },
        tags: [{ id: 9, name: 'pg' }],
        images: [{ id: 3, url: 'https://api.example/article/images/a.png' }],
        createAt: new Date('2026-04-06T00:00:00.000Z'),
      },
    ]
  );

  assert.equal(report.isMatched, true);
  assert.deepEqual(report.stopConditions, {
    countMismatch: false,
    orderMismatch: false,
    structureMismatch: false,
  });
});

test('evaluateFlowParity normalizes equivalent MySQL datetime strings and PostgreSQL Date objects', () => {
  const { evaluateFlowParity } = loadParityScript();

  const report = evaluateFlowParity(
    'getDetail',
    { articleId: 77 },
    [
      {
        id: 77,
        createAt: '2026-04-06 00:00:00',
        updateAt: '2026-04-06T01:02:03.000Z',
      },
    ],
    [
      {
        id: 77,
        createAt: new Date('2026-04-06T00:00:00.000Z'),
        updateAt: new Date('2026-04-06T01:02:03.000Z'),
      },
    ]
  );

  assert.equal(report.isMatched, true);
  assert.deepEqual(report.stopConditions, {
    countMismatch: false,
    orderMismatch: false,
    structureMismatch: false,
  });
});

test('evaluateFlowParity keeps numeric strings as numeric strings instead of coercing them into dates', () => {
  const { evaluateFlowParity } = loadParityScript();

  const report = evaluateFlowParity(
    'getDetail',
    { articleId: 88 },
    [
      {
        id: '88',
        views: '327',
        likes: '2',
      },
    ],
    [
      {
        id: '88',
        views: '327',
        likes: '2',
      },
    ]
  );

  assert.equal(report.isMatched, true);
  assert.deepEqual(report.mysqlPreview[0], {
    id: '88',
    views: '327',
    likes: '2',
  });
  assert.deepEqual(report.pgPreview[0], {
    id: '88',
    views: '327',
    likes: '2',
  });
});

test('evaluateFlowParity flags order mismatches when row content matches but sequence differs', () => {
  const { evaluateFlowParity } = loadParityScript();

  const report = evaluateFlowParity(
    'getRecommendList',
    { offset: 0, limit: 2 },
    [
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ],
    [
      { id: 2, title: 'second' },
      { id: 1, title: 'first' },
    ]
  );

  assert.equal(report.isMatched, false);
  assert.deepEqual(report.stopConditions, {
    countMismatch: false,
    orderMismatch: true,
    structureMismatch: false,
  });
});

test('buildArticleReadParityReport compares article detail, list, recommend, and search flows', async () => {
  const { buildArticleReadParityReport } = loadParityScript();
  const mysqlCalls = [];
  const pgCalls = [];

  const mysqlPool = {
    async query(sql, params) {
      mysqlCalls.push({ sql, params });

      if (/WHERE a\.id = \?/i.test(sql)) {
        return [
          [
            {
              id: 10,
              title: 'PostgreSQL migration guide',
              author: '{"name":"alice","id":1}',
              tags: '[{"name":"pg","id":7}]',
              images: '[{"url":"https://api.example/article/images/cover.png","id":4}]',
              articleUrl: 'https://app.example/article/10',
            },
          ],
        ];
      }

      if (/ORDER BY a\.create_at DESC/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      if (/ORDER BY likes\+a\.views\+commentCount DESC/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      if (/ORDER BY a\.views DESC/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10', views: 99 }]];
      }

      if (/FROM article a where title LIKE \?/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql, params) {
      pgCalls.push({ sql, params });

      if (/WHERE a\.id = \$1/i.test(sql)) {
        return {
          rows: [
            {
              id: 10,
              title: 'PostgreSQL migration guide',
              author: { id: 1, name: 'alice' },
              tags: [{ id: 7, name: 'pg' }],
              images: [{ id: 4, url: 'https://api.example/article/images/cover.png' }],
              articleUrl: 'https://app.example/article/10',
            },
          ],
        };
      }

      if (/ORDER BY a\.create_at DESC/i.test(sql)) {
        return {
          rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }],
        };
      }

      if (/ORDER BY COALESCE\(likes_agg\.likes, 0\)\+a\.views\+COALESCE\(comment_agg\.commentCount, 0\) DESC/i.test(sql)) {
        return {
          rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }],
        };
      }

      if (/ORDER BY a\.views DESC/i.test(sql)) {
        return {
          rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10', views: 99 }],
        };
      }

      if (/FROM article a where title LIKE \$1/i.test(sql)) {
        return {
          rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }],
        };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildArticleReadParityReport(mysqlPool, pgPool, {
    baseURL: 'https://api.example',
    redirectURL: 'https://app.example',
    detailIds: [10],
    listCases: [
      { name: 'date', offset: 0, limit: 5, pageOrder: 'date' },
      { name: 'hot', offset: 0, limit: 5, pageOrder: 'hot' },
    ],
    recommendCases: [{ name: 'default', offset: 0, limit: 5 }],
    searchKeywords: ['PostgreSQL'],
  });

  assert.equal(report.isSuccess, true);
  assert.deepEqual(
    report.flows.map((flow) => flow.flow),
    ['getDetail', 'getList:date', 'getList:hot', 'getRecommendList:default', 'search:PostgreSQL']
  );
  assert.equal(
    pgCalls.some(({ sql }) => /\$\d/.test(sql)),
    true,
    'Expected PostgreSQL queries to use converted $n placeholders'
  );
  assert.equal(mysqlCalls.length, 5);
  assert.equal(pgCalls.length, 5);
});

test('buildArticleReadParityReport still derives a search flow when detailIds are fixed explicitly', async () => {
  const { buildArticleReadParityReport } = loadParityScript();

  const mysqlPool = {
    async query(sql) {
      if (/WHERE a\.id = \?/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      if (/ORDER BY a\.create_at DESC/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      if (/ORDER BY likes\+a\.views\+commentCount DESC/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      if (/ORDER BY a\.views DESC/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10', views: 99 }]];
      }

      if (/FROM article a where title LIKE \?/i.test(sql)) {
        return [[{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      if (/WHERE a\.id = \$1/i.test(sql)) {
        return { rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }] };
      }

      if (/ORDER BY a\.create_at DESC/i.test(sql)) {
        return { rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }] };
      }

      if (/ORDER BY COALESCE\(likes_agg\.likes, 0\)\+a\.views\+COALESCE\(comment_agg\.commentCount, 0\) DESC/i.test(sql)) {
        return { rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }] };
      }

      if (/ORDER BY a\.views DESC/i.test(sql)) {
        return { rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10', views: 99 }] };
      }

      if (/FROM article a where title LIKE \$1/i.test(sql)) {
        return { rows: [{ id: 10, title: 'PostgreSQL migration guide', articleUrl: 'https://app.example/article/10' }] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
  };

  const report = await buildArticleReadParityReport(mysqlPool, pgPool, {
    baseURL: 'https://api.example',
    redirectURL: 'https://app.example',
    detailIds: [10],
  });

  assert.equal(report.flows.some((flow) => flow.flow.startsWith('search:')), true);
});

test('formatArticleReadParitySummary surfaces failing stop conditions', () => {
  const { formatArticleReadParitySummary } = loadParityScript();

  const summary = formatArticleReadParitySummary({
    isSuccess: false,
    flows: [
      {
        flow: 'getList:hot',
        input: { offset: 0, limit: 5, pageOrder: 'hot' },
        isMatched: false,
        stopConditions: {
          countMismatch: false,
          orderMismatch: true,
          structureMismatch: false,
        },
      },
    ],
  });

  assert.match(summary, /Article read parity: FAIL/);
  assert.match(summary, /getList:hot/);
  assert.match(summary, /orderMismatch/);
});
