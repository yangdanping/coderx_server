import { frozenHttpContract } from '../support/frozen-http-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
type LanguageModelV4StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never;
import { createAiChatService } from '../../src/service/ai/ai.service.js';
import { createAiConstraints } from '../../src/service/ai/aiConstraints.service.js';
import { createHttpApp } from '../../src/http/app.js';
import { registerAiChatRoutes } from '../../src/router/ai.router.js';
import { AI_RATE_LIMITS } from '../../src/constants/ai.js';
const messages = [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }];
const tags = async () => Response.json({ models: [{ model: 'qwen2.5:7b', modified_at: '2020-01-01' }] });
function appFor(service: ReturnType<typeof createAiChatService>) {
  return createHttpApp({ buildId: 'test', checkReady: async () => false, registerRoutes: app => registerAiChatRoutes(app, { service }) });
}
function request(app: ReturnType<typeof appFor>, body: unknown = { messages }, path = '/ai/chat', method = 'POST') {
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
const finish: LanguageModelV4StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };
test('real SDK stream yields text before producer completion and preserves SDK protocol', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ async start(c) {
    c.enqueue({ type: 'text-start', id: 'text' }); c.enqueue({ type: 'text-delta', id: 'text', delta: 'first' });
    await gate;
    c.enqueue({ type: 'text-delta', id: 'text', delta: 'last' }); c.enqueue({ type: 'text-end', id: 'text' }); c.enqueue(finish); c.close();
  } }) }) });
  const service = createAiChatService({ baseURL: 'http://fixture/v1', fetch: tags, model: () => model });
  const response = await request(appFor(service));
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader(); let output = '';
  try {
    while (!output.includes('first')) {
      const item = await reader.read(); assert.equal(item.done, false); output += new TextDecoder().decode(item.value);
    }
    assert.ok(!output.includes('last'));
  } finally { release(); }
  for (;;) { const item = await reader.read(); if (item.done) break; output += new TextDecoder().decode(item.value); }
  assert.match(output, /last/); assert.match(output, /\[DONE\]/);
  assert.equal(model.doStreamCalls[0].maxOutputTokens, undefined);
});
test('before-response errors, legacy broad inputs, anonymous validation and limiter', async () => {
  const service = createAiChatService({ baseURL: 'http://fixture/v1', fetch: tags });
  const app = appFor(service);
  for (const role of ['user', 'system', 'tool']) {
    const response = await request(app, { messages: [{ role, content: 'legacy accepted' }] });
    assert.equal(response.status, 503); assert.notEqual((await response.json()).code, 'INVALID_AI_CHAT_PAYLOAD');
  }
  const denied = await request(app, { messages, model: 'not-allowed' });
  assert.equal(denied.status, 503); assert.equal((await denied.json()).code, 'MODEL_NOT_ALLOWED');
  const invalid = await request(app, { messages: [] }); assert.equal(invalid.status, 400);
  const payload = await invalid.json(); assert.equal(payload.code, 'INVALID_AI_CHAT_PAYLOAD'); assert.ok(Date.parse(payload.timestamp));
  const limited = appFor(service);
  for (let i = 0; i < AI_RATE_LIMITS.chat.maxRequests; i++) assert.equal((await request(limited, {})).status, 400);
  const response = await request(limited, {}); assert.equal(response.status, 429); assert.deepEqual(await response.json(), { msg: 'AI 请求过于频繁，请稍后再试', code: 429 });
});
test('SDK masks post-output provider errors', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
    c.enqueue({ type: 'text-start', id: 'x' }); c.enqueue({ type: 'text-delta', id: 'x', delta: 'visible' }); c.enqueue({ type: 'error', error: new Error('SECRET provider request') }); c.close();
  } }) }) });
  const response = await request(appFor(createAiChatService({ baseURL: 'http://fixture/v1', fetch: tags, model: () => model })));
  const output = await response.text(); assert.equal(response.status, 200); assert.match(output, /visible/); assert.match(output, /"type":"error"/); assert.ok(!output.includes('SECRET'));
});
test('catalog cache, allowlist, null vs undefined defaults and pure context/tools', async () => {
  let count = 0, now = 10;
  const service = createAiChatService({ baseURL: 'http://fixture/v1', allowedModels: ['other'], clock: () => now, fetch: async () => { count++; return Response.json({ models: [{ model: 'other', modified_at: '2020-01-01' }, { model: 'hidden', modified_at: '2021-01-01' }] }); } });
  assert.equal(await service.resolveModel(null, 'qwen2.5:7b'), 'other'); await service.getModelCatalog(); assert.equal(count, 1);
  now += 30001; await service.getModelCatalog(); assert.equal(count, 2); await service.getModelCatalog(true); assert.equal(count, 3);
  await assert.rejects(service.streamChat(messages), { code: 'MODEL_NOT_ALLOWED' });
  const helpers = createAiConstraints({ baseURL: 'http://fixture/v1', allowedModels: [], supportsTools: true });
  const context = helpers.sanitizeArticleContext('<p>Hello&nbsp;world</p><p>Second</p>'); assert.equal(context, 'Hello world\nSecond');
  const selections = helpers.sanitizeSelectionContexts([{ text: '<b>selected</b>', id: ' id ' }]); assert.equal(selections[0].id, 'id');
  assert.match(helpers.buildSystemPrompt(context, selections), /selected/); assert.ok(helpers.buildArticleContextTool(context));
  assert.equal(createAiConstraints({ baseURL: '', allowedModels: [], supportsTools: false }).buildArticleContextTool(context), undefined);
});

test('chat routing preserves legacy methods and raw paths', async () => {
  const cases = [['POST', '/ai/chat'], ['POST', '/AI/CHAT/'], ['GET', '/ai/chat'], ['HEAD', '/ai/chat'], ['OPTIONS', '/ai/chat'], ['PUT', '/ai/chat'], ['POST', '/ai/%63hat'], ['POST', '/ai/chat//']];
  const contract = frozenHttpContract('chat');
  const app = appFor(createAiChatService({ baseURL: 'http://fixture/v1', fetch: tags }));
  for (const [method, path] of cases) {
    const response = await request(app, {}, path, method); let body;
    try { body = await response.json(); delete body.timestamp; } catch {}
    contract.assert(method, path, { status: response.status, allow: response.headers.get('allow'), body });
  }
  contract.assertComplete();
});

test('asynchronous provider failure before text stays SDK 200; logs contain fixed events only', async () => {
  const events: string[] = [];
  const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('SECRET provider failure'); } });
  const response = await request(appFor(createAiChatService({ baseURL: 'http://fixture/v1', fetch: tags, model: () => model, logEvent: event => events.push(event) })));
  assert.equal(response.status, 200); const output = await response.text(); assert.match(output, /"type":"error"/); assert.ok(!output.includes('SECRET')); assert.deepEqual(events, ['stream-error']);
  for (const [message, code] of [['connect failed', 'CONNECTION_REFUSED'], ['timeout', 'TIMEOUT'], ['ENOTFOUND', 'HOST_NOT_FOUND'], ['model failed', 'MODEL_NOT_FOUND'], ['other', 'AI_SERVICE_ERROR']]) {
    const service = createAiChatService({ baseURL: 'http://fixture/v1', fetch: async () => { throw new Error(message); } });
    const response = await request(appFor(service)); assert.equal(response.status, 503); assert.equal((await response.json()).code, code);
  }
});
test('tools and context reach SDK while only recent 20 messages reach provider', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) { c.enqueue(finish); c.close(); } }) }) });
  const service = createAiChatService({ baseURL: 'http://fixture/v1', fetch: tags, model: () => model, supportsTools: true });
  const result = await service.streamChat(Array.from({ length: 25 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `message ${index}` }] })), undefined, '<p>article text</p>', ['selected text']);
  await result.toUIMessageStreamResponse().text();
  const options = model.doStreamCalls[0]; assert.equal(options.prompt.length, 21); assert.match(JSON.stringify(options.prompt[0]), /selected text/); assert.ok(!JSON.stringify(options.prompt).includes('message 0'));
  assert.equal(options.tools?.[0].name, 'searchArticleContext'); assert.equal(options.maxOutputTokens, undefined);
});
