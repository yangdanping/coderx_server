import jsonwebtoken from 'jsonwebtoken';
import { routers } from '../support/http-route-inventory.js';
import { allowLoopbackPort } from '../support/runtime-guard.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, readdirSync, statSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

type SmokeMessage = { paths: string[]; keyHashes: string[]; port: number; atBootstrap: { env: string; port: string; resolved: string }; loaded: string[]; routes: string[] };
const { sign } = jsonwebtoken as { sign(payload: object, key: string, options: { algorithm: 'RS256' }): string };

function isSmokeMessage(value: unknown): value is SmokeMessage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'ready' ||
    !('paths' in value) || !Array.isArray(value.paths) || !value.paths.every((item: unknown) => typeof item === 'string') ||
    !('keyHashes' in value) || !Array.isArray(value.keyHashes) || !value.keyHashes.every((item: unknown) => typeof item === 'string') ||
    !('port' in value) ||
    typeof value.port !== 'number' ||
    !('loaded' in value) ||
    !Array.isArray(value.loaded) ||
    !('routes' in value) ||
    !Array.isArray(value.routes) ||
    !value.routes.every((item: unknown) => typeof item === 'string') ||
    !value.loaded.every((item: unknown) => typeof item === 'string') ||
    !('atBootstrap' in value)
  )
    return false;
  const info = value.atBootstrap;
  return (
    typeof info === 'object' &&
    info !== null &&
    'env' in info &&
    typeof info.env === 'string' &&
    'port' in info &&
    typeof info.port === 'string' &&
    'resolved' in info &&
    typeof info.resolved === 'string'
  );
}

for (const mode of ['source', 'dist'] as const) {
  test(`${mode} entry loads the selected environment before bootstrap`, { timeout: 15000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hono-smoke-'));
    const envFile = join(dir, '.env');
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    writeFileSync(join(dir, 'private.key'), keys.privateKey);
    writeFileSync(join(dir, 'public.key'), keys.publicKey);
    mkdirSync(join(dir, 'media', 'avatar'), { recursive: true });
    writeFileSync(join(dir, 'media', 'avatar', 'fixture-avatar.png'), 'avatar-fixture-bytes');
    mkdirSync(join(dir, 'media', 'video'));
    writeFileSync(join(dir, 'media', 'video', 'fixture-Clip.mp4'), '0123456789');
    writeFileSync(envFile, `APP_HOST=127.0.0.1\nAPP_PORT=0\nBUILD_ID=smoke-build\nFRONTEND_URL=https://frontend.example.test/\nHONO_SMOKE_VALUE=isolated\nDATABASE_URL=postgresql://test@postgres.example.invalid/test\nJWT_PRIVATE_KEY_PATH=${join(dir, 'private.key')}\nJWT_PUBLIC_KEY_PATH=${join(dir, 'public.key')}\nMEDIA_ROOT=${join(dir, 'media')}\nMEDIA_MUTATIONS_PAUSED=false\nMEDIA_READ_MODE=${mode === 'source' ? 'local' : 'r2_preferred'}\nMEDIA_CDN_BASE_URL=https://cdn.example.test/\nPUBLIC_API_ORIGIN=https://api.example.test///\nLOG_ROOT=${join(dir, 'logs')}\nOLLAMA_HOST=http://ollama.example.invalid\nOLLAMA_PORT=11434\n`);
    // The ESM loader reports canonical paths even when the temporary root is a symlink.
    const release = mode === 'dist' ? join(realpathSync(dir), 'release') : realpathSync(process.cwd());
    const codeRoot = resolve(release, mode === 'source' ? 'src' : 'dist');
    if (mode === 'dist') {
      cpSync(resolve('dist'), codeRoot, { recursive: true });
      writeFileSync(join(release, 'package.json'), JSON.stringify({ type: 'module' }));
      symlinkSync(resolve('node_modules'), join(release, 'node_modules'), 'dir');
    }
    const extension = mode === 'source' ? 'ts' : 'js';
    const entry = resolve(codeRoot, 'main.' + extension);
    const expectedMaintenance = Object.values(routers).flatMap(entries => entries.flatMap(({ chain, methods, path }) =>
      chain[0] === 'mediaMutationMaintenance' ? methods.map(method => `${method} ${path}`) : [],
    ));
    assert.equal(expectedMaintenance.length, 12);
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { createHash } from 'node:crypto';
      import { fileURLToPath } from 'node:url';
      import { statSync } from 'node:fs';
      import { join } from 'node:path';
      import { Pool } from 'pg';
      import { hashSync } from 'bcryptjs';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        if (String(input) === 'http://ollama.example.invalid:11434/api/tags') {
          return Response.json({ models: [{ model: 'qwen2.5:7b', modified_at: '2026-11-18T00:00:00Z' }] });
        }
        return originalFetch(input, options);
      };
      const end = Pool.prototype.end;
      let poolClosed = 0;
      let filename;
      let found;
      let transactionStep = 0;
      let attempts = 0;
      let completedFollow = false;
      let publisherCreated = 0;
      let publisherDestroyed = 0;
      let publisherMessages = 0;
      const createNotificationClient = url => {
        assert.equal(url, 'redis://127.0.0.1:6379/0');
        publisherCreated++;
        return {
          isOpen: false,
          isReady: false,
          on() {},
          async connect() { this.isOpen = this.isReady = true; },
          async publish(channel, payload) {
            assert.equal(completedFollow, true);
            assert.equal(channel, 'coderx:notification:new');
            assert.deepEqual(JSON.parse(payload), {
              event: 'notification:new',
              notification: { id: 99, recipientId: 8, actorId: 7, type: 'follow' },
            });
            publisherMessages++;
            return 1;
          },
          destroy() { publisherDestroyed++; this.isOpen = this.isReady = false; },
        };
      };
      const sqlTrace = ['BEGIN', "INSERT INTO file (user_id, filename, mimetype, size, file_type) VALUES ($1,$2,$3,$4,'image') RETURNING id;", 'INSERT INTO image_meta (file_id, width, height, is_cover) VALUES ($1,$2,$3,FALSE);', 'COMMIT'];
      Pool.prototype.connect = async function() {
        assert.equal(this.options.connectionString, 'postgresql://test@postgres.example.invalid/test');
        if (attempts === 2) {
          let step = 0;
          const followQueries = [
            [/^BEGIN$/, undefined, []],
            [/^DELETE FROM user_follow/, ['8',7], []],
            [/^INSERT INTO user_follow/, ['8',7], []],
            [/pg_advisory_xact_lock/i, ['follow:8:7:user:8'], []],
            [/ORDER BY created_at DESC/i, ['8',7,'follow','user','8'], []],
            [/INSERT INTO notifications/i, ['8',7,'follow','user','8',null,null,'{}'], [{ id: 99 }]],
            [/WHERE n\\.id =/i, [99], [{ id: 99, recipientId: 8, actorId: 7, type: 'follow' }]],
            [/^COMMIT$/, undefined, []],
          ];
          return {
            async query(sql, params) {
              const [pattern, expected, rows] = followQueries[step++];
              assert.match(sql, pattern);
              assert.deepEqual(params, expected);
              const command = sql.trim().split(/\\s+/, 1)[0];
              return { command, rows, fields: [], rowCount: command === 'DELETE' ? 0 : rows.length };
            },
            release() { assert.equal(step, followQueries.length); completedFollow = true; },
          };
        }
        const shouldFail = ++attempts > 1;
        transactionStep = 0;
        return {
          async query(sql, params) {
            const expected = shouldFail && transactionStep === 3 ? 'ROLLBACK' : sqlTrace[transactionStep];
            transactionStep++;
            assert.equal(sql, expected);
            if (sql.startsWith('INSERT INTO file')) {
              filename = params[1];
              assert.match(filename, /^[0-9a-f-]+\\.webp$/);
              assert.equal(params[0], 7);
              assert.equal(params[2], 'image/webp');
              assert.equal(params[3], statSync(join(process.env.MEDIA_ROOT, 'img', filename)).size);
              return { command: 'INSERT', rows: [{ id: 23 }], fields: [], rowCount: 1 };
            }
            if (sql.startsWith('INSERT INTO image_meta')) {
              assert.deepEqual(params, [23, 2560, 1280]);
              if (shouldFail) throw new Error('fixture metadata insert failed');
            }
            return { command: sql.split(' ', 1)[0], rows: [], fields: [], rowCount: 1 };
          },
          release() { assert.equal(transactionStep, 4); transactionStep++; },
        };
      };
      Pool.prototype.query = async function(sql, params) {
        assert.equal(this.options.connectionString, 'postgresql://test@postgres.example.invalid/test');
        if (sql.startsWith('SELECT * FROM "user" WHERE name =')) {
          assert.deepEqual(params, ['fixture']);
          const password = hashSync('fixture-password', 4);
          return { command: 'SELECT', rows: [{ id: 7, name: 'fixture', password }], fields: [], rowCount: 1 };
        }
        if (sql.startsWith('SELECT * FROM avatar')) {
          assert.ok(['7', '8'].includes(params[0]));
          const filename = params[0] === '7' ? 'fixture-avatar.png' : 'missing-avatar.png';
          return { command: 'SELECT', rows: [{ filename, mimetype: 'image/png' }], fields: [], rowCount: 1 };
        }
        if (sql.includes('FROM media_object')) {
          assert.equal(${JSON.stringify(mode)}, 'dist');
          assert.equal(transactionStep, 5);
          assert.deepEqual(params, [23]);
          assert.match(sql, /provider = 'r2'\\s+AND status = 'ready'/);
          found = true;
          return { command: 'SELECT', rows: [{ id: 1, fileId: 23, provider: 'r2', status: 'ready', variant: 'original', objectKey: 'images/a b.webp', sizeBytes: 5, sha256: 'a'.repeat(64) }], fields: [], rowCount: 1 };
        }
        if (sql.includes('FROM article_history ah')) {
          if (sql.includes('SELECT COUNT(*) as total')) {
            assert.deepEqual(params, ['007']);
            return { command: 'SELECT', rows: [{ total: 1 }], fields: [], rowCount: 1 };
          }
          assert.deepEqual(params, ['007', undefined, undefined]);
          assert.ok(sql.includes("https://api.example.test/article/images/"));
          assert.ok(sql.includes("https://frontend.example.test/article/"));
          return { command: 'SELECT', rows: [{ id: 12, excerpt: 'hello', status: 0 }], fields: [], rowCount: 1 };
        }
        if (sql.includes('a.content AS "contentJson"')) {
          assert.deepEqual(params, ['12']);
          assert.ok(sql.includes("https://api.example.test/article/images/"));
          assert.ok(sql.includes("https://frontend.example.test/article/"));
          return { command: 'SELECT', rows: [{ id: 12, status: 0, contentJson: null, images: [{ id: 23, url: 'fixture-stale-url' }] }], fields: [], rowCount: 1 };
        }
        if (sql.startsWith('SELECT status FROM "user"')) {
          assert.deepEqual(params, ['007']);
          throw new Error('fixture status lookup failed');
        }
        if (sql.includes('LEFT JOIN video_meta') && sql.includes("WHERE f.id = $1 AND f.file_type = 'video'")) {
          assert.deepEqual(params, ['91']);
          return { command: 'SELECT', rows: [], fields: [], rowCount: 0 };
        }
        if (sql.includes('FROM file')) {
          if (sql.startsWith('SELECT * FROM file WHERE filename LIKE')) {
            assert.deepEqual(params, [filename + '%']);
            return { command: 'SELECT', rows: [{ filename, mimetype: 'image/webp' }], fields: [], rowCount: 1 };
          }
          assert.equal(${JSON.stringify(mode)}, 'source');
          assert.equal(transactionStep, 5);
          assert.deepEqual(params, [23]);
          found = true;
          return { command: 'SELECT', rows: [{ id: 23, filename, file_type: 'image' }], fields: [], rowCount: 1 };
        }
        if (sql.includes('FROM flow_post fp')) {
          const detail = sql.includes('WHERE fp.id = $1');
          assert.deepEqual(params, detail ? [42] : [2, 2]);
          return { command: 'SELECT', rows: [{ id: '42', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fixture' }] }] }, bodyText: 'fixture', author: { id: '7', name: 'fixture', nickname: 'Fixture', avatarUrl: '' }, media: [], createAt: new Date('2026-11-10T00:00:00Z') }], fields: [], rowCount: 1 };
        }
        if (sql.includes('COUNT(*)::int AS total FROM flow_post')) {
          assert.deepEqual(params, []);
          return { command: 'SELECT', rows: [{ total: '1' }], fields: [], rowCount: 1 };
        }
        if (sql.includes('FROM draft') && sql.includes('draft_type')) {
          assert.deepEqual(params, ['007']);
          return { command: 'SELECT', rows: [], fields: [], rowCount: 0 };
        }
        if (sql.startsWith('SELECT * FROM collect WHERE id =')) {
          assert.deepEqual(params, ['01', '007']);
          return { command: 'SELECT', rows: [], fields: [], rowCount: 0 };
        }
        if (sql.trimStart().startsWith('UPDATE notifications')) {
          assert.ok(sql.includes('WHERE id = $1 AND recipient_id = $2'));
          assert.ok(sql.includes('COALESCE(read_at, now())'));
          assert.deepEqual(params, ['31', '007']);
          return { command: 'UPDATE', rows: [], fields: [], rowCount: 0 };
        }
        if (sql.startsWith('SELECT * FROM tag')) {
          assert.equal(sql, 'SELECT * FROM tag ORDER BY id ASC LIMIT $1 OFFSET $2;');
          assert.deepEqual(params, ['99', '0']);
        } else {
          assert.ok(sql.includes('LEFT JOIN user_tag_preference'));
          assert.ok(sql.includes('utp.user_id = $1'));
          assert.deepEqual(params, ['007']);
        }
        return { command: 'SELECT', rows: [{ id: 12, name: 'fixture' }], fields: [], rowCount: 1 };
      };
      Pool.prototype.end = function() { poolClosed++; return end.call(this); };
      process.on('exit', () => {
        assert.equal(poolClosed, 1, 'candidate pool closes exactly once');
        if (completedFollow) assert.deepEqual([publisherCreated, publisherMessages, publisherDestroyed], [1, 1, 1], 'one owned publisher is opened lazily and closed');
      });
      const loaded = new Set();
      let atBootstrap;
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          const { url } = result;
          if (url.startsWith('file:')) {
            const file = fileURLToPath(url);
            loaded.add(file);
            if (file === ${JSON.stringify(resolve(codeRoot, 'hono.bootstrap.' + extension))}) {
              atBootstrap = { env: process.env.HONO_SMOKE_VALUE, port: process.env.APP_PORT, resolved: file };
            }
          }
          return result;
        },
      });
      const { start } = await import(${JSON.stringify(entry)});
      const { createHttpApp } = await import(${JSON.stringify(resolve(codeRoot, 'http/app.' + extension))});
      let routes;
      const server = await start({ createNotificationClient, createApp(options) {
        const app = createHttpApp(options);
        const signature = ({ method, path }) => method + ' ' + path;
        const firstHandlers = new Map();
        for (const route of app.routes) {
          if (route.method !== 'ALL' && !firstHandlers.has(signature(route))) firstHandlers.set(signature(route), route.handler);
        }
        routes = [...firstHandlers.keys()];
        const maintenance = firstHandlers.get('POST /flow');
        assert.equal(typeof maintenance, 'function');
        const guarded = app.routes.filter(route => route.handler === maintenance);
        assert.deepEqual(guarded.map(signature).sort(), ${JSON.stringify(expectedMaintenance.sort())});
        for (const route of guarded) assert.equal(firstHandlers.get(signature(route)), maintenance);
        return app;
      } });
      assert.equal(publisherCreated, 0);
      const ctx = server.runtimeContext;
      const hash = value => createHash('sha256').update(value).digest('hex');
      process.send({
        kind: 'ready',
        paths: [ctx.config.mediaRoot, ctx.config.logRoot, ctx.config.privateKeyPath, ctx.config.publicKeyPath],
        keyHashes: [hash(ctx.privateKey), hash(ctx.publicKey)],
        port: server.address().port,
        atBootstrap, loaded: [...loaded], routes,
      });
      process.on('disconnect', () => server.close(error => { if (error) { console.error(error); process.exitCode = 1; } }));`;
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', APP_ENV_FILE: envFile, CODERX_TEST_RESOURCE_ROOT: dir };
    for (const name of Object.keys(env)) {
      if (/^(?:PG|MEDIA_|R2_|AWS_|GOOGLE_|GITHUB_|REDIS_|AI_|OLLAMA_)/.test(name) || ['APP_PORT', 'APP_HOST', 'DATABASE_URL', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH', 'BACKGROUND_JOBS_ENABLED', 'PUBLIC_API_ORIGIN', 'LOG_ROOT', 'BUILD_ID', 'FRONTEND_URL'].includes(name)) delete env[name];
    }
    const child = spawn(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), ...(mode === 'source' ? ['--import=tsx'] : []), '--input-type=module', '-e', script], { env, cwd: release, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let errors = '';
    let output = '';
    const hiddenCredentials = ['fixture-password', 'isolated-oauth-code-sentinel', 'isolated-oauth-id-token-sentinel'];
    child.stdout?.on('data', data => { output += String(data); });
    child.stderr?.on('data', (data) => {
      errors += String(data);
    });
    const exited = new Promise<number | null>((resolvePromise) => {
      child.once('exit', resolvePromise);
      child.once('error', () => resolvePromise(null));
    });
    let smokeCompleted = false;
    try {
      const data = await new Promise<SmokeMessage>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('child startup timed out')), 5000);
        child.once('message', (message) => {
          clearTimeout(timer);
          if (isSmokeMessage(message)) resolvePromise(message);
          else reject(new Error('child returned an invalid startup message'));
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`child exited ${code}: ${errors}`));
        });
      });
      assert.deepEqual(data.paths, [join(dir, 'media'), join(dir, 'logs'), join(dir, 'private.key'), join(dir, 'public.key')]);
      assert.deepEqual(data.keyHashes, [keys.privateKey, keys.publicKey].map(key => createHash('sha256').update(key).digest('hex')));
      assert.equal(data.atBootstrap.env, 'isolated');
      assert.equal(data.atBootstrap.port, '0');
      assert.equal(data.atBootstrap.resolved, resolve(codeRoot, `hono.bootstrap.${extension}`));
      assert.ok(data.loaded.includes(resolve(codeRoot, `constants/ai.${extension}`)));
      assert.ok(!data.loaded.some((path) => ['tasks', 'ingest'].some((part) => path.startsWith(resolve(codeRoot, part) + '/'))));
      assert.ok(data.loaded.includes(resolve(codeRoot, `router/flow.router.${extension}`)));
      assert.ok(data.loaded.includes(resolve(codeRoot, `controller/flow.controller.${extension}`)));
      assert.ok(data.loaded.includes(resolve(codeRoot, `app/config.${extension}`)));
      assert.ok(!data.loaded.includes(resolve(codeRoot, `app/database.${extension}`)));
      assert.ok(!data.loaded.includes(resolve(codeRoot, 'service/mediaRuntime.service.js')));
      assert.ok(data.loaded.includes(resolve(codeRoot, `service/flow.factory.${extension}`)));
      assert.ok(!data.loaded.includes(resolve(codeRoot, 'service/flow.service.js')));
      if (mode === 'dist') assert.ok(!data.loaded.some((path) => path.startsWith(resolve('src') + '/')));
      const revoke = allowLoopbackPort(data.port);
      try {
        assert.equal((await fetch(`http://127.0.0.1:${data.port}/`, { signal: AbortSignal.timeout(5000) })).status, 404);
        const live = await fetch(`http://127.0.0.1:${data.port}/health/live`, { headers: { Origin: 'https://frontend.example.test' }, signal: AbortSignal.timeout(5000) });
        assert.deepEqual(await live.json(), { status: 'ok', buildId: 'smoke-build' });
        assert.equal(live.headers.get('access-control-allow-origin'), 'https://frontend.example.test');
        assert.equal((await fetch(`http://127.0.0.1:${data.port}/health/ready`, { signal: AbortSignal.timeout(5000) })).status, 503);
        const candidateRequest = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${data.port}${path}`, {
          redirect: 'manual', signal: AbortSignal.timeout(5000), ...init,
        });
        const preflight = await candidateRequest('/tag', {
          method: 'OPTIONS', headers: { Origin: 'https://frontend.example.test', 'Access-Control-Request-Method': 'POST' },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://frontend.example.test');
        assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
        assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
        const malformed = await candidateRequest('/flow', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
        });
        assert.equal(malformed.status, 500);
        assert.deepEqual(await malformed.json(), { msg: '服务器内部错误', code: 500 });
        const video = await candidateRequest('/ArTiClE/VIDEO/fixture-Clip.mp4/', { headers: { range: 'bytes=2-5' } });
        assert.equal(video.status, 206);
        assert.equal(video.headers.get('content-type'), 'video/mp4');
        assert.equal(video.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(video.headers.get('content-length'), '4');
        assert.equal(video.headers.get('accept-ranges'), 'bytes');
        assert.equal(await video.text(), '2345');
        assert.equal(video.headers.get('cache-control'), null);
        const invalidRange = await candidateRequest('/article/video/fixture-Clip.mp4', { headers: { range: 'bytes=5-10' } });
        assert.equal(invalidRange.status, 416);
        assert.equal(invalidRange.headers.get('content-range'), 'bytes */10');
        assert.deepEqual(await invalidRange.json(), { msg: 'Range 请求无效', code: -1 });
        const videoHead = await candidateRequest('/article/video/fixture-Clip.mp4', { method: 'HEAD' });
        assert.equal(videoHead.status, 200);
        assert.equal(videoHead.headers.get('content-length'), '10');
        assert.equal(await videoHead.text(), '');
        const login = await candidateRequest('/UsEr/LoGiN/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'fixture', password: 'fixture-password' }),
        });
        assert.equal(login.status, 200);
        const loginBody = await login.json();
        assert.equal(loginBody.code, 0);
        assert.equal(loginBody.data.id, 7);
        assert.equal(loginBody.data.name, 'fixture');
        hiddenCredentials.push(loginBody.data.token);
        const checked = await candidateRequest('/user/checkAuth', {
          headers: { authorization: `Bearer ${loginBody.data.token}` },
        });
        assert.equal(checked.status, 200);
        assert.deepEqual(await checked.json(), { code: 0 });
        const status = await candidateRequest('/OAUTH/StAtUs/');
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { code: 0, data: { google: false, github: false, googleClientId: null } });
        const callback = await candidateRequest('/oauth/github/callback');
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.get('location'), 'https://frontend.example.test//oauth/callback?error=missing_code');
        await callback.text();
        const rejectedCallback = await candidateRequest('/oauth/github/callback?code=isolated-oauth-code-sentinel');
        assert.equal(rejectedCallback.status, 302);
        assert.match(rejectedCallback.headers.get('location') ?? '', /error=/);
        await rejectedCallback.text();
        const idToken = await candidateRequest('/oauth/google/idtoken', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: 'isolated-oauth-id-token-sentinel' }),
        });
        assert.deepEqual(await idToken.json(), { msg: 'Google OAuth 未配置，请联系管理员', code: -1 });
        const avatar = await candidateRequest('/user/7/avatar', { headers: { Range: 'bytes=0-2' } });
        assert.equal(avatar.status, 200);
        assert.equal(avatar.headers.get('content-type'), 'image/png');
        assert.equal(avatar.headers.get('transfer-encoding'), 'chunked');
        assert.equal(await avatar.text(), 'avatar-fixture-bytes');
        const avatarHead = await candidateRequest('/USER/7/AVATAR/', { method: 'HEAD' });
        assert.equal(avatarHead.status, 200);
        assert.equal(avatarHead.headers.get('content-length'), null);
        assert.equal(await avatarHead.text(), '');
        const staleAvatar = await candidateRequest('/user/8/avatar');
        assert.equal(staleAvatar.status, 404);
        assert.equal(await staleAvatar.text(), 'Not Found');
        assert.equal((await candidateRequest('/health/live')).status, 200);
        const list = await fetch(`http://127.0.0.1:${data.port}/tag`, { signal: AbortSignal.timeout(5000) });
        assert.equal(list.status, 200);
        assert.deepEqual(await list.json(), { data: [{ id: 12, name: 'fixture' }], code: 0 });
        const order = await fetch(`http://127.0.0.1:${data.port}/tag/order`, { signal: AbortSignal.timeout(5000) });
        assert.equal(order.status, 401);
        assert.deepEqual(await order.json(), { msg: '未认证/token无效', code: 401 });
        const authorization = `Bearer ${sign({ id: '007' }, keys.privateKey, { algorithm: 'RS256' })}`;
        const draft = await candidateRequest('/DrAfT/', { headers: { authorization } });
        assert.equal(draft.status, 200);
        assert.deepEqual(await draft.json(), { data: null, code: 0 });
        const unknownStatus = await candidateRequest('/article', { method: 'POST', headers: { authorization } });
        assert.equal(unknownStatus.status, 200);
        assert.deepEqual(await unknownStatus.json(), { msg: '参数错误: contentJson 不能为空', code: -1 });
        const authenticatedOrder = await fetch(`http://127.0.0.1:${data.port}/tag/order`, {
          headers: { authorization },
          signal: AbortSignal.timeout(5000),
        });
        const orderBody = await authenticatedOrder.json();
        assert.equal(authenticatedOrder.status, 200, JSON.stringify(orderBody));
        assert.deepEqual(orderBody, { data: [{ id: 12, name: 'fixture' }], code: 0 });
        const history = await candidateRequest('/HiStOrY/', { headers: { authorization } });
        assert.equal(history.status, 200);
        assert.deepEqual(await history.json(), {
          data: { result: [{ id: 12, excerpt: 'hello', status: 0 }], total: 1, pageNum: null, pageSize: null }, code: 0,
        });
        const collect = await candidateRequest('/collect/01/articles?idList=malformed', {
          method: 'DELETE', headers: { authorization },
        });
        assert.equal(collect.status, 403);
        assert.deepEqual(await collect.json(), { msg: '不具备操作的权限', code: 403 });
        const notification = await candidateRequest('/notification/31/read', {
          method: 'PATCH', headers: { authorization },
        });
        assert.equal(notification.status, 200);
        assert.deepEqual(await notification.json(), {
          data: { affectedRows: 0, changedRows: 0, insertId: 0, rowCount: 0, command: 'UPDATE' }, code: 0,
        });
        const mediaCollection = `http://127.0.0.1:${data.port}/media/images`;
        const unauthorized = await fetch(mediaCollection, { method: 'POST', signal: AbortSignal.timeout(5000) });
        assert.equal(unauthorized.status, 401);
        assert.deepEqual(await unauthorized.json(), { msg: '未认证/token无效', code: 401 });
        const options = await fetch(mediaCollection, { method: 'OPTIONS', signal: AbortSignal.timeout(5000) });
        assert.equal(options.status, 200);
        assert.equal(options.headers.get('allow'), 'POST');
        const wrongMethod = await fetch(mediaCollection, { signal: AbortSignal.timeout(5000) });
        assert.equal(wrongMethod.status, 405);
        assert.equal(wrongMethod.headers.get('allow'), 'POST');
        const unauthorizedDelete = await candidateRequest('/media/images/1', { method: 'DELETE' });
        assert.equal(unauthorizedDelete.status, 401);
        assert.deepEqual(await unauthorizedDelete.json(), { msg: '未认证/token无效', code: 401 });

        const missing = await fetch(`http://127.0.0.1:${data.port}/media/images`, { method: 'POST', headers: { authorization }, signal: AbortSignal.timeout(5000) });
        assert.equal(missing.status, 400);
        assert.deepEqual(await missing.json(), { msg: '请选择要上传的图片', code: 400 });
        const corrupt = new FormData();
        corrupt.append('image', new Blob(['corrupt image'], { type: 'image/png' }), 'corrupt.png');
        const invalidId = `Bearer ${sign({ id: 0 }, keys.privateKey, { algorithm: 'RS256' })}`;
        const invalidUser = await fetch(mediaCollection, { method: 'POST', body: corrupt, headers: { authorization: invalidId }, signal: AbortSignal.timeout(5000) });
        assert.equal(invalidUser.status, 400);
        assert.deepEqual(await invalidUser.json(), { msg: '参数错误: userId 必须是正整数', code: 400 });
        const invalidImage = await fetch(mediaCollection, { method: 'POST', body: corrupt, headers: { authorization }, signal: AbortSignal.timeout(5000) });
        assert.equal(invalidImage.status, 400);
        assert.deepEqual(await invalidImage.json(), { msg: '图片必须是 JPEG、PNG 或 WebP 格式', code: 400 });

        const multipart = new FormData();
        const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: 'red' } }).png().toBuffer();
        multipart.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'fixture.png');
        const upload = await fetch(`http://127.0.0.1:${data.port}/MeDiA/ImAgEs/`, { method: 'POST', body: multipart, headers: { authorization }, signal: AbortSignal.timeout(5000) });
        const asset = await upload.json();
        assert.equal(upload.status, 200, JSON.stringify(asset));
        const imageRoot = join(dir, 'media', 'img');
        const [thumbnail, original] = readdirSync(imageRoot).sort();
        assert.equal(thumbnail, original.replace(/\.webp$/, '-small.webp'));
        const expectedUrl = mode === 'source' ? `https://api.example.test/article/images/${original}` : 'https://cdn.example.test/images/a%20b.webp';
        assert.deepEqual(asset, { code: 0, data: { id: 23, url: expectedUrl, thumbnailUrl: mode === 'source' ? `${expectedUrl}?type=small` : expectedUrl, mimeType: 'image/webp', sizeBytes: statSync(join(imageRoot, original)).size, width: 2560, height: 1280 } });
        assert.equal((await sharp(join(imageRoot, thumbnail)).metadata()).width, 640);
        const article = await candidateRequest('/article/12', { headers: { authorization } });
        assert.equal(article.status, 200);
        assert.deepEqual(await article.json(), {
          data: { id: 12, status: 0, contentJson: null, images: [{ id: 23, url: expectedUrl }], contentHtml: '', excerpt: '' }, code: 0,
        });
        const articleImage = await candidateRequest(`/ArTiClE/images/${original}?type=small`);
        assert.equal(articleImage.status, 200);
        assert.equal(articleImage.headers.get('content-type'), 'image/webp');
        assert.equal(articleImage.headers.get('transfer-encoding'), 'chunked');
        assert.deepEqual(Buffer.from(await articleImage.arrayBuffer()), readFileSync(join(imageRoot, thumbnail)));
        const articleImageHead = await candidateRequest(`/article/images/${original}`, { method: 'HEAD' });
        assert.equal(articleImageHead.status, 200);
        assert.equal(articleImageHead.headers.get('content-length'), null);
        assert.equal(await articleImageHead.text(), '');
        const failure = await fetch(mediaCollection, { method: 'POST', body: multipart, headers: { authorization }, signal: AbortSignal.timeout(5000) });
        assert.equal(failure.status, 500);
        assert.deepEqual(await failure.json(), { msg: '服务器内部错误', code: 500 });
        assert.deepEqual(readdirSync(imageRoot).sort(), [thumbnail, original]);
        const follow = await candidateRequest('/user/8/follow', {
          method: 'POST', headers: { authorization: `Bearer ${loginBody.data.token}` },
        });
        assert.equal(follow.status, 200);
        assert.deepEqual(await follow.json(), {
          data: { isFollowed: true, action: 'followed', notificationCreated: true, notification: { id: 99, recipientId: 8, actorId: 7, type: 'follow' } },
          code: 0,
        });
        const flowItem = {
          id: 42, author: { id: 7, name: 'Fixture', username: 'fixture', avatarUrl: '' },
          body: 'fixture', bodyHtml: '<p>fixture</p>', media: [], likes: 0, comments: 0, liked: false,
          createdAt: '2026-11-10T00:00:00.000Z',
        };
        const flow = await candidateRequest('/flow/42');
        assert.equal(flow.status, 200);
        assert.deepEqual(await flow.json(), { data: flowItem, code: 0 });
        const flowFeed = await candidateRequest('/FlOw/?pageNum=2&pageSize=2');
        assert.equal(flowFeed.status, 200);
        assert.deepEqual(await flowFeed.json(), { data: { items: [flowItem], total: 1, page: 2, pageSize: 2 }, code: 0 });
        assert.equal((await candidateRequest('/flow/%34%32')).status, 404);
        const deniedFlow = await candidateRequest('/flow', { method: 'POST' });
        assert.equal(deniedFlow.status, 401);
        assert.deepEqual(await deniedFlow.json(), { msg: '未认证/token无效', code: 401 });
        const flowDraft = await candidateRequest('/FlOw/DrAfT/', { headers: { authorization } });
        assert.equal(flowDraft.status, 200);
        assert.deepEqual(await flowDraft.json(), { data: null, code: 0 });
        const invalidFlowDraft = await candidateRequest('/flow/draft', { method: 'PUT', headers: { authorization } });
        assert.equal(invalidFlowDraft.status, 200);
        assert.deepEqual(await invalidFlowDraft.json(), { msg: '参数错误: content 必须是对象', code: -1 });
        const invalidFlowDraftId = await candidateRequest('/flow/draft/0', { method: 'DELETE', headers: { authorization } });
        assert.equal(invalidFlowDraftId.status, 200);
        assert.deepEqual(await invalidFlowDraftId.json(), { msg: '参数错误: draftId 必须是正整数', code: -1 });
        const videoMetadata = await candidateRequest('/VIDEO/91/');
        assert.equal(videoMetadata.status, 200);
        assert.deepEqual(await videoMetadata.json(), { msg: '视频不存在', code: -1 });
        const noVideo = await candidateRequest('/video', { method: 'POST', headers: { authorization } });
        assert.equal(noVideo.status, 400);
        assert.deepEqual(await noVideo.json(), { msg: '缺少视频文件', code: 400 });
        const aiHealth = await candidateRequest('/AI/HEALTH/');
        assert.equal(aiHealth.status, 200);
        const health = await aiHealth.json();
        assert.equal(health.status, 'online');
        assert.deepEqual(health.models.map((model: { value: string }) => model.value), ['qwen2.5:7b']);
        const noAuthCompletion = await candidateRequest('/ai/completion', { method: 'POST' });
        assert.equal(noAuthCompletion.status, 401);

        const candidatePath = (path: string) => {
          if (path.startsWith('/^')) return '/flow/:flowId{[1-9][0-9]*}';
          // The candidate normalizes this case-insensitive literal route at registration.
          if (path === '/user/checkAuth') return '/user/checkauth';
          return path;
        };
        const expected = Object.values(routers).flatMap(entries => entries.flatMap(({ methods, path }) =>
          methods.filter(method => method !== 'HEAD').map(method => `${method} ${candidatePath(path)}`),
        ));
        assert.equal(Object.keys(routers).length, 16);
        assert.equal(expected.length, 85);
        assert.deepEqual(data.routes.sort(), [...expected, 'GET /health/live', 'GET /health/ready'].sort());
        smokeCompleted = true;
      } finally {
        revoke();
      }
    } finally {
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        const result = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('child cleanup timed out')), 5000).unref())]);
        assert.equal(result, 0, `child failed to close: ${errors}`);
        const logFiles = readdirSync(join(dir, 'logs'), { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.log'));
        const logged = [output, errors, ...logFiles.map(file => readFileSync(join(dir, 'logs', file), 'utf8'))].join('\n');
        if (smokeCompleted) assert.ok(logged.includes('User moderation status lookup failed'), 'candidate logs the legacy status lookup fallback');
        for (const credential of hiddenCredentials) {
          assert.ok(!logged.includes(credential), 'candidate log contained a credential');
        }
        assert.doesNotMatch(logged, /\$2[aby]\$\d{2}\$/);
      } finally {
        clearTimeout(timer);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

test('an explicitly missing environment file fails startup', () => {
  const entry = resolve('dist/main.js');
  const dir = mkdtempSync(join(tmpdir(), 'hono-missing-env-'));
  try {
    const child = spawnSync(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), entry], { env: { ...process.env, APP_ENV_FILE: join(dir, 'missing'), CODERX_TEST_RESOURCE_ROOT: dir }, timeout: 5000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr.toString(), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
