import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const guard = join(project, 'test/support/runtime-guard.cjs');
const entries = [
  { kind: 'source', root: 'src', extension: 'ts', loader: ['--import=tsx'] },
  { kind: 'compiled', root: 'dist', extension: 'js', loader: [] },
] as const;

function entryDirectory(entry: typeof entries[number], root: string) {
  if (entry.kind === 'source') return project;
  cpSync(join(project, 'dist'), join(root, 'dist'), { recursive: true });
  copyFileSync(join(project, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

function testEnvironment(root: string, envFile: string) {
  return {
    PATH: process.env.PATH,
    TMPDIR: tmpdir(),
    NODE_ENV: 'production',
    APP_ENV_FILE: envFile,
    CODERX_TEST_RESOURCE_ROOT: root,
  };
}

test('ingest worker starts lazily and drains scheduled work before closing its actions', async () => {
  const worker = await import('../../src/ingest/worker.js');
  assert.equal(typeof worker.createScheduledIngest, 'function');
  let callback: (() => Promise<unknown>) | undefined;
  let finishCollection!: () => void;
  const collecting = new Promise<void>((resolve) => {
    finishCollection = resolve;
  });
  const events: string[] = [];
  const runtime = worker.createScheduledIngest({
    config: { enabled: true, autoPublish: false, schedule: '* * * * *', timezone: 'UTC' },
    cron: {
      schedule(_expression, next) {
        callback = next;
        return {
          stop() {
            events.push('stop');
          },
        };
      },
    },
    logger: {
      info() {},
      error(_message, error) {
        throw error;
      },
    },
    async createActions() {
      events.push('create');
      return {
        async collect() {
          await collecting;
          events.push('collect');
          return {};
        },
        async enrich() {
          events.push('enrich');
          return {};
        },
        async close() {
          events.push('close');
        },
      };
    },
  });

  assert.deepEqual(events, []);
  assert.ok(callback);
  const run = callback();
  const closed = runtime.close();
  assert.equal(runtime.close(), closed);
  assert.deepEqual(events, ['create', 'stop']);
  finishCollection();
  await Promise.all([run, closed]);
  assert.deepEqual(events, ['create', 'stop', 'collect', 'enrich', 'close']);
});

for (const entry of entries) {
  test(`the ${entry.kind} ingest CLI executes with scheduling disabled and closes its pool on success and failure`, () => {
    const root = mkdtempSync(join(tmpdir(), 'coderx-ingest-cli-'));
    try {
      const envFile = join(root, '.env');
      writeFileSync(envFile, 'INGEST_ENABLED=false\nDATABASE_URL=postgresql://test@postgres.example.invalid/test\n');
      const fixture = join(root, 'pg.mjs');
      writeFileSync(
        fixture,
        String.raw`
        import assert from 'node:assert/strict';
        import pg from ${JSON.stringify(import.meta.resolve('pg'))};
        pg.Pool.prototype.query = async function (sql, params) {
          assert.match(sql, /WHERE c.status = ANY\(\$1::text\[\]\)/);
          assert.match(sql, /LIMIT \$2/);
          assert.deepEqual(params, [['pending'], 60]);
          if (process.env.INGEST_FIXTURE_QUERY_ERROR === '1') throw new Error('fixture query failed');
          return { command: 'SELECT', rows: [{ id: 31, status: 'pending', titleOriginal: 'Fixture article' }], fields: [] };
        };
        pg.Pool.prototype.end = async () => process.stderr.write('pool closed\n');
      `,
      );

      const cwd = entryDirectory(entry, root);
      const cli = join(cwd, entry.root, 'ingest', `cli.${entry.extension}`);
      for (const fail of [false, true]) {
        const result = spawnSync(process.execPath, ['--require', guard, '--import', fixture, ...entry.loader, cli, 'list', '--json'], {
          cwd,
          env: {
            ...testEnvironment(root, envFile),
            INGEST_FIXTURE_QUERY_ERROR: fail ? '1' : '0',
          },
          encoding: 'utf8',
          timeout: 10_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, fail ? 1 : 0, result.stderr);
        assert.equal(result.stderr, fail ? 'pool closed\nfixture query failed\n' : 'pool closed\n');
        assert.equal(result.stdout, fail ? '' : '[\n  {\n    "id": 31,\n    "status": "pending",\n    "titleOriginal": "Fixture article"\n  }\n]\n');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`the ${entry.kind} ingest worker skips the scheduled run and exits on SIGTERM`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'coderx-ingest-worker-'));
    const envFile = join(root, '.env');
    writeFileSync(envFile, 'INGEST_ENABLED=false\nINGEST_CRON=* * * * * *\nINGEST_TIMEZONE=UTC\n');
    const cwd = entryDirectory(entry, root);
    const worker = join(cwd, entry.root, 'ingest', `worker.${entry.extension}`);
    const child = spawn(process.execPath, ['--require', guard, ...entry.loader, worker], {
      cwd,
      env: testEnvironment(root, envFile),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    let output = '';
    let error = '';
    const skipped = '[ingest] scheduled run skipped because INGEST_ENABLED is disabled';
    child.stdout.on('data', (value: Buffer) => {
      output += value.toString('utf8');
      if (output.includes(skipped)) child.kill('SIGTERM');
    });
    child.stderr.on('data', (value: Buffer) => {
      error += value.toString('utf8');
    });
    try {
      assert.deepEqual(await once(child, 'close'), [0, null], error);
      assert.ok(output.includes(skipped), output);
      assert.equal(error, '');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
}
