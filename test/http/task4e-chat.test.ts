import test from 'node:test';
import assert from 'node:assert/strict';
import { once, getEventListeners } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from 'ai/test';
import { serve } from '@hono/node-server';
import { createAiChatService } from '../../src/service/ai/ai.service.js';
import { createHttpApp } from '../../src/http/app.js';
import { registerAiChatRoutes } from '../../src/router/ai.router.js';

type ModelPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never;
const modelId = 'qwen2.5:7b';
const headers = { 'content-type': 'application/json', connection: 'close' };
const payload = JSON.stringify({ messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] });
const tags = () => Response.json({ models: [{ model: modelId, modified_at: '2020-01-01' }] });
const finish: ModelPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const testTimeout = { timeout: 8000 };

function gate() {
  let open!: () => void;
  const reached = new Promise<void>(resolve => { open = resolve; });
  return { open, reached };
}

async function within<T>(value: T | Promise<T>, label: string): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      value,
      delay(1800, undefined, { signal: timer.signal }).then(() => assert.fail(`Timed out waiting for ${label}`)),
    ]);
  } finally { timer.abort(); }
}

function appFor(service: ReturnType<typeof createAiChatService>) {
  return createHttpApp({
    buildId: 'test', checkReady: async () => false,
    registerRoutes: app => registerAiChatRoutes(app, { service }),
  });
}

async function readThrough(reader: ReadableStreamDefaultReader<Uint8Array>, token: string) {
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes(token)) {
    const item = await reader.read();
    assert.equal(item.done, false, `Stream closed before ${token}`);
    output += decoder.decode(item.value, { stream: true });
  }
  return output;
}

function finishStream() {
  return new ReadableStream<ModelPart>({ start(controller) { controller.enqueue(finish); controller.close(); } });
}

test('request abort cancels a pending catalog lookup without poisoning another chat', testTimeout, async () => {
  const pending = gate();
  const stop = gate();
  const abort = new AbortController();
  const events: string[] = [];
  let catalogSignal: AbortSignal | null | undefined;
  let catalogCalls = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: finishStream() }) });
  const service = createAiChatService({
    baseURL: 'http://fixture.invalid/v1', model: () => model, logEvent: event => events.push(event),
    fetch: async (_url, options) => {
      if (++catalogCalls > 1) return tags();
      catalogSignal = options?.signal;
      pending.open();
      return new Promise(resolve => {
        const onAbort = () => stop.open();
        catalogSignal?.addEventListener('abort', onAbort, { once: true });
        void stop.reached.then(() => {
          catalogSignal?.removeEventListener('abort', onAbort);
          // Simulate a fetch implementation already returning when cancellation wins.
          resolve(Response.json({ models: [] }));
        });
      });
    },
  });
  const app = appFor(service);
  const cancelled = app.request('/ai/chat', { method: 'POST', headers, body: payload, signal: abort.signal });
  try {
    await within(pending.reached, 'catalog request');
    const unaffected = await within(app.request('/ai/chat', { method: 'POST', headers, body: payload }), 'parallel chat');
    assert.match(await within(unaffected.text(), 'parallel chat completion'), /\[DONE\]/);
    abort.abort();
    await within(stop.reached, 'catalog abort');
    const response = await within(cancelled, 'cancelled setup response');
    await within(response.body?.cancel(), 'cancelled setup body cleanup');
    assert.equal(model.doStreamCalls.length, 1);
    assert.deepEqual(events, []);
    assert.deepEqual((await service.getModelCatalog()).map(item => item.value), [modelId]);
    assert.equal(catalogCalls, 2, 'aborted lookup must preserve the successful request cache');
  } finally { stop.open(); await within(cancelled, 'cancelled setup cleanup'); }
});

test('cancelling app.request response body stops SDK work while request signal remains live', testTimeout, async () => {
  const stopped = gate();
  const teardown = gate();
  const request = new Request('http://fixture.invalid/ai/chat', { method: 'POST', headers, body: payload });
  const listenerCount = getEventListeners(request.signal, 'abort').length;
  let modelSignal: AbortSignal | undefined;
  let stoppedCount = 0;
  const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => {
    modelSignal = abortSignal;
    return { stream: new ReadableStream<ModelPart>({
      start(controller) {
        const onAbort = () => {
          stoppedCount++;
          stopped.open();
          controller.error(abortSignal?.reason);
        };
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({ type: 'text-delta', id: 'text', delta: 'first' });
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        void teardown.reached.then(() => {
          abortSignal?.removeEventListener('abort', onAbort);
          if (!abortSignal?.aborted) controller.close();
        });
      },
    }) };
  } });
  const events: string[] = [];
  const response = await appFor(createAiChatService({
    baseURL: 'http://fixture.invalid/v1', fetch: async () => tags(), model: () => model,
    logEvent: event => events.push(event),
  })).request(request);
  const reader = response.body!.getReader();
  try {
    await within(readThrough(reader, 'first'), 'first SDK text');
    const pending = reader.read();
    const cancelling = reader.cancel('consumer stopped reading');
    await within(stopped.reached, 'model abort');
    await within(cancelling, 'response reader cancellation');
    assert.ok(modelSignal?.aborted);
    assert.equal(stoppedCount, 1);
    assert.equal(request.signal.aborted, false);
    assert.equal(getEventListeners(request.signal, 'abort').length, listenerCount);
    assert.deepEqual(await within(pending, 'pending response read'), { done: true, value: undefined });
    assert.deepEqual(events, []);
  } finally {
    teardown.open();
    reader.releaseLock();
  }
});

test('normal completion and post-output error release the request abort listener', testTimeout, async () => {
  const events: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({ doStream: async () => {
    if (++call !== 2) return { stream: finishStream() };
    return { stream: new ReadableStream<ModelPart>({ start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text' });
      controller.enqueue({ type: 'text-delta', id: 'text', delta: 'visible' });
      controller.enqueue({ type: 'error', error: new Error('provider content') });
      controller.close();
    } }) };
  } });
  const service = createAiChatService({
    baseURL: 'http://fixture.invalid/v1', fetch: async () => tags(), model: () => model,
    logEvent: event => events.push(event),
  });
  const app = appFor(service);
  for (const expectError of [false, true, false]) {
    const abort = new AbortController();
    const request = new Request('http://fixture.invalid/ai/chat', { method: 'POST', headers, body: payload, signal: abort.signal });
    const baseline = getEventListeners(request.signal, 'abort').length;
    const response = await app.request(request);
    const output = await within(response.text(), 'SDK response completion');
    assert.match(output, /\[DONE\]/);
    assert.equal(output.includes('"type":"error"'), expectError);
    assert.ok(!output.includes('provider content'));
    assert.equal(getEventListeners(request.signal, 'abort').length, baseline);
    abort.abort();
    assert.equal(model.doStreamCalls.at(-1)?.abortSignal?.aborted, false, 'completed model must have a detached request signal');
  }
  assert.deepEqual(events, ['stream-error']);
});

test('SDK response encoding errors abort the provider and release the request listener', testTimeout, async () => {
  const stopped = gate();
  const teardown = gate();
  const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => ({
    stream: new ReadableStream<ModelPart>({ start(controller) {
      const onAbort = () => {
        stopped.open();
        controller.error(abortSignal?.reason);
      };
      // Simulate a serializer failure whose message contains provider data.
      const invalidMetadata = { test: { toJSON() { throw new Error('private provider data'); } } } as unknown as NonNullable<Extract<ModelPart, { type: 'text-start' }>['providerMetadata']>;
      controller.enqueue({ type: 'text-start', id: 'text' });
      controller.enqueue({ type: 'text-delta', id: 'text', delta: 'first' });
      controller.enqueue({ type: 'text-delta', id: 'text', delta: 'invalid', providerMetadata: invalidMetadata });
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      void teardown.reached.then(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        if (!abortSignal?.aborted) controller.close();
      });
    } }),
  }) });
  const request = new Request('http://fixture.invalid/ai/chat', { method: 'POST', headers, body: payload });
  const baseline = getEventListeners(request.signal, 'abort').length;
  const app = appFor(createAiChatService({ baseURL: 'http://fixture.invalid/v1', fetch: async () => tags(), model: () => model }));
  try {
    const response = await within(app.request(request), 'response before encoding failure');
    await assert.rejects(within(response.text(), 'SDK encoder error'), { message: 'AI chat response stream failed' });
    await within(stopped.reached, 'model abort after SDK encoding failure');
    assert.equal(getEventListeners(request.signal, 'abort').length, baseline);
  } finally { teardown.open(); }
});

test('request abort cancels SDK attachment download during model setup', testTimeout, async () => {
  const downloading = gate();
  const stopped = gate();
  const teardown = gate();
  const fetch = globalThis.fetch;
  const attachment = 'https://fixture.invalid/document.pdf';
  const abort = new AbortController();
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: finishStream() }) });
  // Keep all traffic local to the test while checking the actual SDK download
  // path, including its URL validation.
  globalThis.fetch = async (input, options) => {
    assert.equal(input, attachment);
    const signal = options?.signal;
    const onAbort = () => stopped.open();
    signal?.addEventListener('abort', onAbort, { once: true });
    downloading.open();
    try {
      await Promise.race([stopped.reached, teardown.reached]);
      signal?.throwIfAborted();
      return new Response('fixture bytes', { headers: { 'content-type': 'application/pdf' } });
    } finally { signal?.removeEventListener('abort', onAbort); }
  };
  try {
    const app = appFor(createAiChatService({ baseURL: 'http://fixture.invalid/v1', fetch: async () => tags(), model: () => model }));
    const body = JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'file', mediaType: 'application/pdf', url: attachment }] }] });
    const response = await within(app.request('/ai/chat', { method: 'POST', headers, body, signal: abort.signal }), 'attachment response');
    const reader = response.body!.getReader();
    try {
      await within(downloading.reached, 'SDK attachment fetch');
      abort.abort();
      await within(stopped.reached, 'attachment abort');
      assert.deepEqual(await within(reader.read(), 'attachment response close'), { done: true, value: undefined });
      assert.equal(model.doStreamCalls.length, 0);
    } finally {
      teardown.open();
      await within(reader.cancel(), 'attachment response cleanup');
      reader.releaseLock();
    }
  } finally { globalThis.fetch = fetch; }
});

test('failed attachment closes a concurrent download after the SDK error response', testTimeout, async () => {
  const slowStarted = gate();
  const slowClosed = gate();
  const releaseSlow = gate();
  const attachmentServer = createServer((req, res) => {
    if (req.url === '/slow.pdf') {
      res.once('close', slowClosed.open);
      slowStarted.open();
      void releaseSlow.reached.then(() => {
        if (!res.destroyed) res.end('late attachment bytes');
      });
      return;
    }
    if (req.url === '/fail.pdf') {
      void slowStarted.reached.then(() => res.writeHead(500).end('private attachment detail'));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(attachmentServer);
  const originalFetch = globalThis.fetch;
  const base = 'https://fixture.invalid';
  globalThis.fetch = (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, base);
    return originalFetch(`http://127.0.0.1:${port(attachmentServer)}${url.pathname}`, options);
  };
  const request = new Request('http://fixture.invalid/ai/chat', {
    method: 'POST', headers,
    body: JSON.stringify({ messages: [{ role: 'user', parts: [
      { type: 'file', mediaType: 'application/pdf', url: `${base}/fail.pdf` },
      { type: 'file', mediaType: 'application/pdf', url: `${base}/slow.pdf` },
    ] }] }),
  });
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: finishStream() }) });
  try {
    const app = appFor(createAiChatService({ baseURL: 'http://fixture.invalid/v1', fetch: async () => tags(), model: () => model }));
    const response = await within(app.request(request), 'attachment error response');
    const output = await within(response.text(), 'attachment SDK error stream');
    assert.match(output, /\[DONE\]/);
    assert.match(output, /"type":"error"/);
    assert.ok(!output.includes('private attachment detail'));
    await within(slowClosed.reached, 'failed attachment sibling socket close');
    assert.equal(request.signal.aborted, false);
    assert.equal(model.doStreamCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    releaseSlow.open();
    await close(attachmentServer);
  }
});

async function listen(server: Server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await within(listening, 'fixture listen');
}

function port(server: ReturnType<typeof serve>) {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: ReturnType<typeof serve>) {
  const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if ('closeAllConnections' in server) server.closeAllConnections();
  await within(closing, 'server close');
}

function openChat(server: ReturnType<typeof serve>) {
  const client = httpRequest({
    host: '127.0.0.1', port: port(server), method: 'POST', path: '/ai/chat', headers, agent: false,
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    client.once('response', resolve);
    client.once('error', reject);
  });
  // Destroying a connection during setup can reject before a response is read.
  void response.catch(() => {});
  client.end(payload);
  return { client, response };
}

function providerEvent(res: ServerResponse, text: string | null) {
  res.write(`data: ${JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: modelId,
    choices: [{ index: 0, delta: text === null ? {} : { role: 'assistant', content: text }, finish_reason: text === null ? 'stop' : null }],
  })}\n\n`);
}

test('real Node disconnect closes downstream OpenAI-compatible HTTP requests during and after setup', testTimeout, async () => {
  for (const phase of ['catalog', 'before text', 'after text'] as const) {
    const reachedProvider = gate();
    const providerClosed = gate();
    const allowNextWork = gate();
    let stall = true;
    let generatedAfterDisconnect = 0;
    let completions = 0;
    function holdProvider(res: ServerResponse, resume: () => void) {
      res.once('close', providerClosed.open);
      reachedProvider.open();
      void allowNextWork.reached.then(() => {
        if (!res.destroyed) {
          generatedAfterDisconnect++;
          resume();
        }
      });
    }
    const provider = createServer((req, res) => {
      if (req.url === '/api/tags') {
        const respond = () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ models: [{ model: modelId, modified_at: '2020-01-01' }] }));
        };
        if (stall && phase === 'catalog') holdProvider(res, respond);
        else respond();
        return;
      }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      completions++;
      req.resume();
      req.on('end', () => {
        const respond = () => {
          providerEvent(res, 'later');
          providerEvent(res, null);
          res.end('data: [DONE]\n\n');
        };
        res.setHeader('content-type', 'text/event-stream');
        if (!stall) { respond(); return; }
        if (phase === 'after text') providerEvent(res, 'first');
        holdProvider(res, respond);
      });
    });
    await listen(provider);
    const app = appFor(createAiChatService({ baseURL: `http://127.0.0.1:${port(provider)}/v1` }));
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false });
    try {
      await within(once(server, 'listening'), 'Hono listen');
      const { client, response } = openChat(server);
      try {
        await within(reachedProvider.reached, phase);
        if (phase === 'after text') {
          const incoming = await within(response, 'client response');
          const body = incoming.iterator({ destroyOnReturn: false });
          try {
            let output = '';
            await within((async () => {
              for await (const chunk of body) {
                output += chunk.toString();
                if (output.includes('first')) return;
              }
              assert.fail('Stream ended without first text');
            })(), 'first provider text');
          } finally { void body.return?.(); }
        }
        const clientClosed = new Promise<void>(resolve => client.once('close', resolve));
        client.destroy();
        await within(clientClosed, 'client socket close');
        await within(providerClosed.reached, `provider socket close (${phase})`);
        allowNextWork.open();
        stall = false;
        const next = await within(fetch(`http://127.0.0.1:${port(server)}/ai/chat`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(1800) }), 'next chat');
        const output = await within(next.text(), 'next response');
        assert.match(output, /later/);
        assert.match(output, /\[DONE\]/);
        assert.equal(generatedAfterDisconnect, 0);
        assert.equal(completions, phase === 'catalog' ? 1 : 2);
      } finally { client.destroy(); }
    } finally {
      allowNextWork.open();
      try { await close(server); } finally { await close(provider); }
    }
  }
});

test('a paused Node client bounds provider pulls before resuming and completes', testTimeout, async () => {
  const chunks = 256;
  const chunk = 'x'.repeat(64 * 1024);
  let pulls = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<ModelPart>({
    start(controller) { controller.enqueue({ type: 'text-start', id: 'text' }); },
    pull(controller) {
      if (++pulls <= chunks) {
        controller.enqueue({ type: 'text-delta', id: 'text', delta: chunk });
      } else {
        controller.enqueue({ type: 'text-end', id: 'text' });
        controller.enqueue(finish);
        controller.close();
      }
    },
  }) }) });
  const app = appFor(createAiChatService({ baseURL: 'http://fixture.invalid/v1', fetch: async () => tags(), model: () => model }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false });
  try {
    await within(once(server, 'listening'), 'Hono listen');
    const { client, response } = openChat(server);
    try {
      const incoming = await within(response, 'paused client headers');
      const received = within(once(incoming, 'readable'), 'first paused client bytes');
      await received;
      await delay(100);
      assert.ok(pulls < chunks / 2, `Paused client consumed ${pulls} of ${chunks} provider chunks`);
      let bytes = 0;
      let suffix = '';
      await within((async () => {
        for await (const part of incoming) {
          bytes += part.length;
          suffix = part.subarray(-128).toString();
        }
      })(), 'resumed socket drain');
      assert.equal(pulls, chunks + 1);
      assert.ok(bytes >= chunks * chunk.length);
      assert.match(suffix, /\[DONE\]/);
    } finally { client.destroy(); }
  } finally { await close(server); }
});
