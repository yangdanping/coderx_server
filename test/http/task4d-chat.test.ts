import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/hono.bootstrap.js';

test('candidate chat validates anonymous requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hono-chat-'));
  const values: Record<string, string> = { CODERX_TEST_RESOURCE_ROOT: root, APP_ENV_FILE: join(root, '.env'), JWT_PRIVATE_KEY_PATH: join(root, 'private.key'), JWT_PUBLIC_KEY_PATH: join(root, 'public.key'), MEDIA_ROOT: join(root, 'media'), LOG_ROOT: join(root, 'logs'), APP_PORT: '0', APP_HOST: '127.0.0.1', BACKGROUND_JOBS_ENABLED: 'false', DATABASE_URL: 'postgresql://test@postgres.example.invalid/test' };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  writeFileSync(values.APP_ENV_FILE!, ''); writeFileSync(values.JWT_PRIVATE_KEY_PATH!, 'temporary'); writeFileSync(values.JWT_PUBLIC_KEY_PATH!, 'temporary');
  try {
    const server = await startServer();
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ messages: [] }) });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, 'INVALID_AI_CHAT_PAYLOAD');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('source and emitted bootstrap stream real provider output over Node transport', async () => {
  const { createServer } = await import('node:http');
  const distBootstrap = new URL('../../dist/hono.bootstrap.js', import.meta.url).href;
  const { startServer: startDist } = await import(distBootstrap) as { startServer: typeof startServer };
  for (const start of [startServer, startDist]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const provider = createServer(async (req, res) => {
      calls++;
      if (req.url === '/api/tags') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ model: 'qwen2.5:7b', modified_at: '2020-01-01' }] })); return; }
      for await (const _ of req) { /* consume local fixture request */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (content: string | null, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'qwen2.5:7b', choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason }] })}\n\n`;
      res.write(event('early', null));
      await gate;
      res.write(event('late', null)); res.write(event(null, 'stop')); res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert.ok(address && typeof address !== 'string');
    const root = mkdtempSync(join(tmpdir(), 'chat-composition-'));
    const values = { CODERX_TEST_RESOURCE_ROOT: root, APP_ENV_FILE: join(root, '.env'), JWT_PRIVATE_KEY_PATH: join(root, 'private.key'), JWT_PUBLIC_KEY_PATH: join(root, 'public.key'), MEDIA_ROOT: join(root, 'media'), LOG_ROOT: join(root, 'logs'), APP_PORT: '0', APP_HOST: '127.0.0.1', BACKGROUND_JOBS_ENABLED: 'false', DATABASE_URL: 'postgresql://test@postgres.example.invalid/test', OLLAMA_HOST: 'http://127.0.0.1', OLLAMA_PORT: String(address.port), AI_ALLOWED_MODELS: 'qwen2.5:7b', FRONTEND_URL: 'https://frontend.example.test' };
    const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]])); Object.assign(process.env, values);
    writeFileSync(values.APP_ENV_FILE, ''); writeFileSync(values.JWT_PRIVATE_KEY_PATH, 'temporary'); writeFileSync(values.JWT_PUBLIC_KEY_PATH, 'temporary');
    try {
      const server = await start();
      try {
        assert.equal(calls, 0, 'startup must not contact provider');
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const response = await fetch(`http://127.0.0.1:${address.port}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: values.FRONTEND_URL, connection: 'close' }, body: JSON.stringify({ messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }) });
        assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), values.FRONTEND_URL); assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.equal(response.headers.get('cache-control'), 'no-cache');
        const reader = response.body!.getReader(); let text = '';
        try {
          while (!text.includes('early')) { const item = await reader.read(); assert.equal(item.done, false); text += new TextDecoder().decode(item.value); }
          assert.ok(!text.includes('late'));
        } finally { release(); }
        for (;;) { const item = await reader.read(); if (item.done) break; text += new TextDecoder().decode(item.value); }
        const events = text.trimEnd().split('\n\n').map(frame => {
          assert.match(frame, /^data: [^\n]+$/);
          return frame.slice('data: '.length);
        });
        assert.equal(events.pop(), '[DONE]');
        const frames = events.map(event => JSON.parse(event) as { type: string; id?: string; delta?: string });
        assert.equal(frames[0]?.type, 'start');
        assert.equal(frames.at(-1)?.type, 'finish');
        const textFrames = frames.filter(frame => frame.type.startsWith('text-'));
        assert.deepEqual(textFrames.map(frame => frame.type), ['text-start', 'text-delta', 'text-delta', 'text-end']);
        assert.ok(textFrames[0]?.id);
        assert.ok(textFrames.every(frame => frame.id === textFrames[0].id));
        assert.equal(textFrames[1].delta, 'early');
        assert.equal(textFrames[2].delta, 'late');
        assert.equal(calls, 2);
      } finally { release(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    } finally {
      release(); await new Promise<void>(resolve => provider.close(() => resolve()));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    }
  }
});
