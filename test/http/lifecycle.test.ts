import { observeImports } from '../support/observe-imports.js';
import { Pool } from 'pg';
import '../support/runtime-guard.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startServer } from '../../src/hono.bootstrap.js';
import { parseRuntimeConfig } from '../../src/app/runtime.config.js';
import { LocalMediaStore } from '../../src/storage/localMediaStore.js';

async function withEnvironment(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hono-lifecycle-'));
  const pgNames = Object.keys(process.env).filter(name => /^PG/.test(name));
  const names = ['CODERX_TEST_RESOURCE_ROOT', 'APP_ENV_FILE', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH', 'MEDIA_ROOT', 'LOG_ROOT', 'APP_PORT', 'APP_HOST', 'BACKGROUND_JOBS_ENABLED', 'SHUTDOWN_TIMEOUT_MS', 'DATABASE_URL', ...pgNames];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of pgNames) delete process.env[name];
  Object.assign(process.env, { CODERX_TEST_RESOURCE_ROOT: root, APP_ENV_FILE: join(root, '.env'), JWT_PRIVATE_KEY_PATH: join(root, 'private.key'), JWT_PUBLIC_KEY_PATH: join(root, 'public.key'), MEDIA_ROOT: join(root, 'media'), LOG_ROOT: join(root, 'logs'), APP_PORT: '0', APP_HOST: '127.0.0.1', BACKGROUND_JOBS_ENABLED: 'true' });
  process.env.DATABASE_URL = 'postgresql://test@postgres.example.invalid/test';
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'private.key'), 'temporary-private');
  writeFileSync(join(root, 'public.key'), 'temporary-public');
  try { await run(root); } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(root, { recursive: true, force: true });
  }
}

test('enabled startup starts and stops injected jobs before ending the pool', async t => withEnvironment(async () => {
  const originalEnd: (this: Pool) => Promise<void> = Pool.prototype.end;
  const closePool = t.mock.method(Pool.prototype, 'end', async function (this: Pool) {
    assert.equal(stops, 1);
    await originalEnd.call(this);
  });
  let starts = 0, stops = 0;
  const server = await startServer({ createJobs: () => ({ start() { starts++; }, stop() { stops++; } }) });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(closePool.mock.callCount(), 1);
}));

test('startup failure closes server, stops created jobs and ends the pool', async t => withEnvironment(async () => {
  const closePool = t.mock.method(Pool.prototype, 'end');
  let stops = 0;
  await assert.rejects(startServer({ createJobs: () => ({ start() { throw Error('start failed'); }, stop() { stops++; } }) }), /start failed/);
  assert.equal(stops, 1);
  assert.equal(closePool.mock.callCount(), 1);
}));

test('listener failure ends the pool without loading job dependencies', async t => withEnvironment(async () => {
  const closePool = t.mock.method(Pool.prototype, 'end');
  let loads = 0;
  await assert.rejects(startServer({ createJobs: () => { loads++; return null; }, serveHttp: () => {
    const server = createServer();
    process.nextTick(() => server.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' })));
    return server;
  } }), /address in use/);
  assert.equal(loads, 0);
  assert.equal(closePool.mock.callCount(), 1);
}));

test('synchronous serve failure ends the pool', async t => withEnvironment(async () => {
  const closePool = t.mock.method(Pool.prototype, 'end');
  await assert.rejects(async () => startServer({ serveHttp() { throw Error('serve failed'); } }), /serve failed/);
  assert.equal(closePool.mock.callCount(), 1);
}));

test('the candidate pool stays open until an in-flight tag request completes', { timeout: 5000 }, async t => withEnvironment(async () => {
  let queryStarted!: () => void;
  const started = new Promise<void>(resolve => { queryStarted = resolve; });
  let completeQuery!: () => void;
  const query = new Promise<void>(resolve => { completeQuery = resolve; });
  t.mock.method(Pool.prototype, 'query', async () => {
    queryStarted();
    await query;
    return { command: 'SELECT', rows: [{ id: 1, name: 'fixture' }], fields: [], rowCount: 1 };
  });
  const originalEnd: (this: Pool) => Promise<void> = Pool.prototype.end;
  let resolveEnd!: () => void;
  const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
  const end = t.mock.method(Pool.prototype, 'end', async function (this: Pool) {
    await originalEnd.call(this);
    resolveEnd();
  });
  const server = await startServer({ createJobs: () => null });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = fetch(`http://127.0.0.1:${address.port}/tag`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(2000) });
  try {
    await Promise.race([started, response.then(result => assert.fail(`unexpected status ${result.status} before query`))]);
    server.close();
    assert.equal(end.mock.callCount(), 0);
    completeQuery();
    assert.deepEqual(await (await response).json(), { data: [{ id: 1, name: 'fixture' }], code: 0 });
    await ended;
    assert.equal(end.mock.callCount(), 1);
  } finally {
    completeQuery();
    if (server.listening) server.close();
  }
}));

test('configured media root preserves trusted-directory checks', async () => withEnvironment(async root => {
  const mediaRoot = parseRuntimeConfig().mediaRoot;
  mkdirSync(mediaRoot);
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(mediaRoot, 'linked'));
  const store = new LocalMediaStore({ rootPath: mediaRoot, publicBaseUrl: '' });
  await assert.rejects(store.head('linked/file'), /symbolic link/);
  mkdirSync(join(mediaRoot, 'untrusted'));
  chmodSync(join(mediaRoot, 'untrusted'), 0o777);
  await assert.rejects(store.head('untrusted/file'), /group\/world-writable/);
}));

test('startup failure closes listener before stuck stop times out', async () => withEnvironment(async () => {
  const { serve } = await import('@hono/node-server');
  process.env.SHUTDOWN_TIMEOUT_MS = '500';
  let closed!: () => void;
  const closedEvent = new Promise<void>(resolve => { closed = resolve; });
  let settled = false;
  const startup = startServer({
    serveHttp: (options, listener) => {
      const server = serve(options, listener);
      server.once('close', () => { assert.equal(server.listening, false); closed(); });
      return server;
    },
    createJobs: () => ({ start() { throw Error('start failed'); }, stop() { return new Promise<void>(() => {}); } }),
  });
  const result = startup.then(() => { settled = true; }, () => { settled = true; });
  await closedEvent;
  assert.equal(settled, false);
  await assert.rejects(startup, /Startup cleanup failed/);
  await result;
}));

test('ingest loads explicitly selected temporary environment and rejects missing selection', async () => withEnvironment(async root => {
  const { loadRuntimeEnvironment } = await import('../../src/ingest/config/runtime.js');
  const selected = join(root, '.env');
  writeFileSync(selected, `INGEST_TEST_VALUE=loaded\nMEDIA_ROOT=${join(root, 'ingest-media')}\n`);
  delete process.env.INGEST_TEST_VALUE;
  delete process.env.MEDIA_ROOT;
  try {
    assert.equal(loadRuntimeEnvironment(), selected);
    assert.equal(process.env.INGEST_TEST_VALUE, 'loaded');
    assert.equal(process.env.MEDIA_ROOT, join(root, 'ingest-media'));
    process.env.APP_ENV_FILE = join(root, 'missing');
    assert.throws(() => loadRuntimeEnvironment(), /ENOENT/);
  } finally { delete process.env.INGEST_TEST_VALUE; }
}));

for (const mode of ['normal', 'reject', 'stuck', 'repeat'] as const) {
  test(`signal closes listener with ${mode} job stop`, { timeout: 5000 }, async () => {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    await withEnvironment(async root => {
      const script = `
        const { startServer } = await import(${JSON.stringify(resolve('dist/hono.bootstrap.js'))});
        const mode = ${JSON.stringify(mode)};
        let server;
        let rejectStop;
        let finishStop;
        let stopCalls = 0;
        startServer({ createJobs: () => ({ start() {}, stop() {
          stopCalls++;
          if (mode === 'repeat') return new Promise(resolve => { finishStop = resolve; });
          if (mode === 'reject') return new Promise((_, reject) => { rejectStop = reject; });
          if (mode === 'stuck') return new Promise(() => {});
        } }), onShutdownError: () => process.send({ kind: 'fatal', listening: server.listening }, () => process.exit(1)) }).then(value => {
          server = value;
          process.on('message', () => {
            if (mode === 'reject') rejectStop(new Error('stop failed'));
            if (mode === 'repeat') {
              if (stopCalls !== 1) process.exit(3);
              finishStop();
              process.disconnect();
            }
          });
          server.on('close', () => process.send({ kind: 'close', listening: server.listening }, () => {
            if (mode === 'normal') process.disconnect();
          }));
          process.send({ kind: 'ready' });
        }).catch(() => process.exit(2));`;
      const env = { ...process.env, APP_ENV_FILE: join(root, '.env'), CODERX_TEST_RESOURCE_ROOT: root, MEDIA_ROOT: join(root, 'media'), LOG_ROOT: join(root, 'logs'), JWT_PRIVATE_KEY_PATH: join(root, 'private.key'), JWT_PUBLIC_KEY_PATH: join(root, 'public.key'), SHUTDOWN_TIMEOUT_MS: '500' };
      const child = spawn(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), '--input-type=module', '-e', script], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let errors = '';
      child.stderr?.on('data', data => { errors += String(data); });
      const exit = new Promise<number | null>((done, fail) => { child.once('exit', done); child.once('error', fail); });
      const messages: Array<{ kind: string; listening?: boolean }> = [];
      const waitFor = (kind: string) => new Promise<void>((done, fail) => {
        if (messages.some(message => message.kind === kind)) return done();
        const onMessage = (message: { kind: string; listening?: boolean }) => {
          if (message.kind === kind) { child.off('message', onMessage); done(); }
        };
        child.on('message', onMessage);
        child.once('exit', code => fail(new Error(`early exit ${code}: ${errors}`)));
      });
      child.on('message', (message: { kind: string; listening?: boolean }) => { messages.push(message); });
      try {
        await waitFor('ready');
        child.kill('SIGTERM');
        await waitFor('close');
        assert.equal(messages.find(message => message.kind === 'close')?.listening, false);
        if (mode === 'reject') child.send('reject');
        if (mode === 'repeat') {
          child.kill('SIGINT');
          child.kill('SIGTERM');
          await new Promise(resolve => setTimeout(resolve, 75));
          assert.equal(child.signalCode, null);
          child.send('finish');
        }
        if (mode === 'reject' || mode === 'stuck') {
          await waitFor('fatal');
          assert.equal(messages.find(message => message.kind === 'fatal')?.listening, false);
        }
        assert.equal(await exit, mode === 'normal' || mode === 'repeat' ? 0 : 1, errors);
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    });
  });
}

test('missing selected environment fails before HTTP runtime dependencies load', async () => withEnvironment(async root => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const script = `
    ${observeImports}
    const { start } = await import('./src/main.js');
    const loadedBootstrap = () => [...loaded].some(path => path.endsWith('/hono.bootstrap.ts'));
    if (loadedBootstrap()) process.exit(2);
    try { await start(); process.exit(3); }
    catch (error) { if (error.code !== 'ENOENT' || loadedBootstrap()) process.exit(4); }
  `;
  const result = spawnSync(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), '--import=tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, APP_ENV_FILE: join(root, 'missing') }, timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
}));
