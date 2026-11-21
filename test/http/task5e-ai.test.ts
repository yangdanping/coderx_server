import jsonwebtoken from 'jsonwebtoken';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { serve } from '@hono/node-server';
import { frozenHttpContract } from '../support/frozen-http-contract.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createHttpApp } from '../../src/http/app.js';
import { createVerifyAuth } from '../../src/middleware/auth.middleware.js';
import { registerAiRoutes } from '../../src/router/ai.router.js';
import { createAiChatService } from '../../src/service/ai/ai.service.js';

const { sign } = jsonwebtoken as {
  sign(payload: object | string, key: KeyObject, options: { algorithm: 'RS256' }): string;
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const token = (id: number) => `Bearer ${sign({ id }, keys.privateKey, { algorithm: 'RS256' })}`;
const alice = token(7);
const bob = token(8);
const legacyDefault = 'qwen2.5:7b';
const alternate = 'alternate:3b';
const start = Date.parse('2026-11-18T00:00:00.000Z');
const defaultModels = [
  { model: legacyDefault, modified_at: '2026-11-17' },
  { model: alternate, modified_at: '2026-10-01' },
  { model: 'hidden:3b', modified_at: '2025-01-01' },
];

function fixture(options: { allowlist?: string[]; tools?: boolean } = {}) {
  let now = start;
  let tags = () => Response.json({ models: defaultModels });
  let generations = 0;
  let probes = 0;
  let generated = JSON.stringify({ suggestions: [' 词 ', '一段中等长度的补全', '这是一句用于验证句子类型分类的较长补全文本'] });
  const seen: { model: string; prompt: unknown; maxOutputTokens?: number }[] = [];
  const service = createAiChatService({
    baseURL: 'http://provider.example.invalid/v1',
    allowedModels: options.allowlist ?? [legacyDefault, alternate],
    supportsTools: options.tools ?? false,
    clock: () => now,
    async fetch(_input, init) {
      assert.ok(init?.signal instanceof AbortSignal);
      probes++;
      return tags();
    },
    model(name) {
      return new MockLanguageModelV4({
        doGenerate: async opts => {
          generations++;
          seen.push({ model: name, prompt: opts.prompt, maxOutputTokens: opts.maxOutputTokens });
          return {
            content: [{ type: 'text', text: generated }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        },
      });
    },
  });
  const app = createHttpApp({
    buildId: 'task5e-ai',
    checkReady: async () => false,
    registerRoutes(app) {
      registerAiRoutes(app, { service, auth: createVerifyAuth(keys.publicKey), clock: () => now });
    },
  });
  return {
    app, service, seen,
    setNow: (value: number) => { now = value; },
    setTags: (factory: () => Response) => { tags = factory; },
    setGeneration: (value: string) => { generated = value; },
    get probes() { return probes; },
    get generations() { return generations; },
  };
}

function completion(app: ReturnType<typeof fixture>['app'], body: unknown = {}, auth = alice, path = '/ai/completion') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

async function expectJson(response: Response, status: number, data: unknown) {
  const json = JSON.stringify(data);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(json)));
  assert.equal(await response.text(), json);
}

function healthBody(now: number, models: { name: string; value: string }[], tools = false) {
  return {
    models,
    status: models.length ? 'online' : 'offline',
    message: models.length ? 'AI service is running' : 'AI service is not available',
    capability: { type: 'assistant', label: 'AI 助手', supportsTools: tools, scopes: ['article_qa', 'writing_completion'] },
    accessPolicy: {
      chat: { allowGuest: true, description: '文章问答助手，支持游客访问' },
      completion: { allowGuest: false, description: '编辑补全仅限登录用户使用' },
    },
    timestamp: new Date(now).toISOString(),
  };
}

const onlineModels = [{ name: 'alternate', value: alternate }, { name: 'qwen2.5', value: legacyDefault }];
const timestamp = new Date(start).toISOString();
const success = {
  success: true,
  suggestions: [
    { id: 'A', text: '词', type: 'word' },
    { id: 'B', text: '一段中等长度的补全', type: 'phrase' },
    { id: 'C', text: '这是一句用于验证句子类型分类的较长补全文本', type: 'sentence' },
  ],
  timestamp,
};

test('public health forces a fresh allowlisted catalog and exposes capability, policy and timestamp', async () => {
  const f = fixture({ tools: true });
  await expectJson(await f.app.request('/AI/HEALTH/'), 200, healthBody(start, onlineModels, true));
  assert.equal(f.probes, 1);
  await expectJson(await completion(f.app, { beforeText: '写作', model: null }), 200, success);
  assert.equal(f.probes, 1, 'completion shares the health catalog cache');
  assert.equal(f.seen[0].model, legacyDefault, 'a null request still prefers the available legacy default');
  f.setNow(start + 1);
  const head = await f.app.request('/ai/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(JSON.stringify(healthBody(start + 1, onlineModels, true)))));
  assert.equal(await head.text(), '');
  assert.equal(f.probes, 2);
  for (const probe of [() => Response.json({ models: [{ model: 'hidden:3b' }] }), () => new Response(null, { status: 500 }), () => { throw new Error('fixture connection failed'); }]) {
    f.setTags(probe);
    await expectJson(await f.app.request('/ai/health'), 200, healthBody(start + 1, [], true));
  }
});

test('completion authenticates before validation and preserves validation order and raw limits', async () => {
  const f = fixture();
  const unauthenticated = { msg: '未认证/token无效', code: 401 };
  for (const auth of ['', 'Bearer invalid']) await expectJson(await completion(f.app, {}, auth), 401, unauthenticated);
  const cases = [
    [{ beforeText: 42, afterText: 1, maxSuggestions: 0, model: 3 }, 'beforeText is required and must be a string'],
    [{ beforeText: 'a'.repeat(2001), afterText: 1 }, 'beforeText 长度不能超过 2000 个字符'],
    [{ beforeText: 'a', afterText: 1, maxSuggestions: 0 }, 'afterText must be a string'],
    [{ beforeText: 'a', afterText: 'b'.repeat(1001) }, 'afterText 长度不能超过 1000 个字符'],
    [{ beforeText: 'a', maxSuggestions: '1', model: 6 }, 'maxSuggestions 必须是 1-3 之间的整数'],
    [{ beforeText: 'a', maxSuggestions: 1.5 }, 'maxSuggestions 必须是 1-3 之间的整数'],
    [{ beforeText: 'a', model: ' ' }, 'model 不能为空'],
    [{ beforeText: 'a', model: 'x'.repeat(101) }, 'model 参数过长'],
  ] as const;
  for (const [body, message] of cases) {
    await expectJson(await completion(f.app, body), 400, { success: false, message, code: 'INVALID_AI_COMPLETION_PAYLOAD', timestamp });
  }
  assert.equal(f.probes, 0);
  assert.equal(f.generations, 0);
});

test('completion uses the real SDK structured output and preserves prompt clipping and suggestions', async () => {
  const f = fixture();
  const before = 'a'.repeat(500);
  const after = 'b'.repeat(200);
  const body = { beforeText: 'x'.repeat(1500) + before, afterText: after + 'y'.repeat(800), maxSuggestions: null };
  await expectJson(await completion(f.app, body, alice, '/AI/COMPLETION/'), 200, success);
  assert.equal(f.seen[0].model, legacyDefault);
  assert.equal(f.seen[0].maxOutputTokens, undefined, 'the SDK ignored legacy maxTokens');
  const prompt = JSON.stringify(f.seen[0].prompt);
  assert.ok(prompt.includes(before));
  assert.ok(prompt.includes(after));
  assert.ok(!prompt.includes('x'.repeat(10)));
  assert.ok(!prompt.includes('y'.repeat(10)));
  f.setGeneration(JSON.stringify({ suggestions: [' 接着写 '] }));
  await expectJson(await completion(f.app, { beforeText: ' ', afterText: null, maxSuggestions: 1 }), 200, {
    success: true, suggestions: [{ id: 'A', text: '接着写', type: 'word' }], timestamp,
  });
  assert.match(JSON.stringify(f.seen[1].prompt), /生成 1 个续写建议/);
  assert.doesNotMatch(JSON.stringify(f.seen[1].prompt), /下文内容/);
});

test('completion preserves allowlist selection, fallback and structured errors', async () => {
  const f = fixture({ allowlist: [alternate] });
  const check = async (body: object, message: string, code: string) => expectJson(await completion(f.app, body), 503, {
    success: false, message, code, suggestions: [], timestamp,
  });
  await check({ beforeText: '写作' }, `模型 "${legacyDefault}" 不在允许列表中，可选模型：${alternate}`, 'MODEL_NOT_ALLOWED');
  await expectJson(await completion(f.app, { beforeText: '写作', model: null }), 200, success);
  assert.equal(f.seen[0].model, alternate);
  f.setGeneration(JSON.stringify({ suggestions: ['ok', 'extra'] }));
  await check({ beforeText: '写作', model: alternate, maxSuggestions: 1 }, 'AI 补全服务暂时不可用', 'COMPLETION_ERROR');
  f.setNow(start + 30000);
  f.setTags(() => new Response(null, { status: 418 }));
  await expectJson(await completion(f.app, { beforeText: '写作', model: alternate }), 503, {
    success: false, message: 'AI 补全服务暂时不可用', code: 'COMPLETION_ERROR', suggestions: [],
    timestamp: new Date(start + 30000).toISOString(),
  });
  f.setTags(() => Response.json({ models: [] }));
  await expectJson(await completion(f.app, { beforeText: '写作', model: alternate }), 503, {
    success: false, message: '当前没有可用的 AI 模型，请先在 Ollama 中拉取并启用模型',
    code: 'MODEL_UNAVAILABLE', suggestions: [], timestamp: new Date(start + 30000).toISOString(),
  });
});

test('completion limiter counts only authenticated traffic and charges invalid payloads to each user', async () => {
  const f = fixture();
  for (let i = 0; i < 31; i++) {
    assert.equal((await completion(f.app, {}, i % 2 ? '' : 'Bearer invalid')).status, 401);
  }
  for (let i = 0; i < 30; i++) {
    assert.equal((await completion(f.app)).status, 400);
  }
  await expectJson(await completion(f.app, { beforeText: '写作' }), 429, { msg: 'AI 请求过于频繁，请稍后再试', code: 429 });
  assert.equal(f.probes, 0);
  await expectJson(await completion(f.app, { beforeText: '写作' }, bob), 200, success);
  assert.equal((await f.app.request('/ai/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 400);
  f.setNow(start + 60000);
  assert.equal((await completion(f.app, { beforeText: '写作' })).status, 200);
});

test('real Ollama transport preserves completion and health responses', { timeout: 10_000 }, async t => {
  const origin = 'https://frontend.example.test';
  let tagsStatus = 200;
  let models = defaultModels;
  let suggestions = [' 词 ', '一段中等长度的补全'];
  let probeCalls = 0;
  const prompts: { messages: { content: string }[]; max_tokens?: number }[] = [];
  const provider = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      probeCalls++;
      response.statusCode = tagsStatus;
      response.end(JSON.stringify({ models }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      prompts.push(data);
      response.end(JSON.stringify({
        id: 'fixture', object: 'chat.completion', created: 1, model: data.model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ suggestions }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  function track(server: Pick<typeof provider, 'close' | 'closeAllConnections'>) {
    t.after(() => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
  }
  provider.listen(0, '127.0.0.1');
  track(provider);
  await once(provider, 'listening');
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== 'string');
  const service = createAiChatService({
    baseURL: `http://127.0.0.1:${providerAddress.port}/v1`,
    allowedModels: [legacyDefault, alternate],
    supportsTools: true,
  });
  const app = createHttpApp({
    allowedOrigins: [origin], buildId: 'task5e-ai', checkReady: async () => true,
    registerRoutes(app) { registerAiRoutes(app, { service, auth: createVerifyAuth(keys.publicKey) }); },
  });
  const candidate = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  assert.ok('closeAllConnections' in candidate);
  track(candidate);
  await once(candidate, 'listening');
  const address = candidate.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  const authorization = 'Bearer ' + sign({ id: 7 }, keys.privateKey, { algorithm: 'RS256' });
  const contract = frozenHttpContract('ai');

  async function request(method: string, path: string, body?: string, user?: string, contentType = 'application/json') {
    const headers: Record<string, string> = { connection: 'close', origin };
    if (user) headers.authorization = user;
    if (body !== undefined) headers['content-type'] = contentType;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body, signal: AbortSignal.timeout(2000),
    });
    const content = await response.text();
    let payload: unknown = content;
    if (content.startsWith('{')) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (Object.hasOwn(parsed, 'timestamp')) {
        assert.ok(typeof parsed.timestamp === 'string');
        assert.equal(new Date(parsed.timestamp).toISOString(), parsed.timestamp);
        parsed.timestamp = 'normalized timestamp';
      }
      assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(content)));
      payload = parsed;
    }
    const contractHeaders = ['content-type', 'content-length', 'allow', 'vary',
      'access-control-allow-origin', 'access-control-allow-credentials'];
    contract.assert(method, path, {
      status: response.status,
      body: payload,
      headers: Object.fromEntries(contractHeaders.map(name => [name, response.headers.get(name)])),
    });
  }

  const send = (body: string, user = authorization, path = '/ai/completion', contentType?: string) =>
    request('POST', path, body, user, contentType);
  await request('GET', '/AI/HEALTH/');
  await request('HEAD', '/ai/health');
  await request('OPTIONS', '/ai/health');
  await request('PUT', '/ai/health');
  await request('GET', '/ai/%68ealth');
  await request('GET', '/ai/health//');
  await request('OPTIONS', '/ai/completion');
  await request('HEAD', '/ai/completion');
  await send('{}', '');
  await send('{}', 'invalid');
  await send('{', '');
  await send(JSON.stringify({ beforeText: 'hi', model: 4, maxSuggestions: 0 }));
  await send('beforeText=hi&maxSuggestions=1', authorization, '/ai/completion', 'application/x-www-form-urlencoded');
  await send(JSON.stringify({
    beforeText: 'x'.repeat(1500) + 'b'.repeat(500),
    afterText: 'a'.repeat(200) + 'y'.repeat(800),
    model: null,
  }), authorization, '/AI/COMPLETION/');
  assert.equal(probeCalls, 2, 'health and HEAD force refresh, completion reuses the catalog');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].max_tokens, undefined);
  assert.match(prompts[0].messages[1].content, /b{500}/);
  assert.match(prompts[0].messages[1].content, /a{200}/);

  await send(JSON.stringify({ beforeText: 'hi', model: 'hidden:3b' }));
  suggestions = [''];
  await send(JSON.stringify({ beforeText: 'hi' }));
  models = [];
  await request('GET', '/ai/health');
  tagsStatus = 503;
  await request('GET', '/ai/health');
  await send(JSON.stringify({ beforeText: 'hi' }));
  t.mock.method(service, 'checkHealth', async () => { throw new Error('probe failed unexpectedly'); });
  await request('GET', '/ai/health');
  contract.assertComplete();
});
