const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { createDefaultActions, parseCliArgs, runCli } = require('@/ingest/cli');
const { loadRuntimeConfig } = require('@/ingest/config/runtime');

test('runtime configuration defaults collection and publication switches off', () => {
  const config = loadRuntimeConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.autoPublish, false);
  assert.equal(config.tagName, '人工智能');
});

test('default CLI actions do not load JWT keys from the web application config', async () => {
  const config = loadRuntimeConfig({
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGDATABASE: 'coderx',
    PGUSER: 'postgres',
    PGPASSWORD: 'test-password', // pragma: allowlist secret
  });

  const actions = createDefaultActions(config);
  await actions.close();
});

test('parseCliArgs accepts known commands and typed options', () => {
  assert.deepEqual(parseCliArgs(['list', '--status', 'enriched,pending', '--limit', '60', '--json']), {
    command: 'list',
    options: {
      statuses: ['enriched', 'pending'],
      limit: 60,
      json: true,
    },
  });
  assert.deepEqual(parseCliArgs(['approve', '--ids', '31,32', '--limit', '8']), {
    command: 'approve',
    options: {
      ids: [31, 32],
      limit: 8,
    },
  });
});

test('parseCliArgs rejects unknown commands, options and invalid positive integers', () => {
  assert.throws(() => parseCliArgs(['delete']), /Unknown command/);
  assert.throws(() => parseCliArgs(['list', '--password', 'secret']), /Unknown option/);
  assert.throws(() => parseCliArgs(['collect', '--limit', '0']), /positive integer/);
});

test('run command collects and enriches but cannot publish with the safe default', async () => {
  const calls = [];
  const actions = {
    async collect(options) {
      calls.push({ action: 'collect', options });
      return { inserted: 8 };
    },
    async enrich(options) {
      calls.push({ action: 'enrich', options });
      return { enriched: 8 };
    },
    async publish(options) {
      calls.push({ action: 'publish', options });
      return { published: 8 };
    },
  };

  const result = await runCli(['run', '--limit', '8'], {
    actions,
    config: { autoPublish: false },
    write() {},
  });

  assert.deepEqual(
    calls.map((call) => call.action),
    ['collect', 'enrich'],
  );
  assert.deepEqual(result, {
    collect: { inserted: 8 },
    enrich: { enriched: 8 },
    publish: { skipped: true, reason: 'INGEST_AUTO_PUBLISH is disabled' },
  });
});

test('run only publishes approved candidates when auto-publish is explicitly enabled', async () => {
  const calls = [];
  const actions = {
    async collect() {
      calls.push('collect');
      return {};
    },
    async enrich() {
      calls.push('enrich');
      return {};
    },
    async publish() {
      calls.push('publish');
      return { published: 2 };
    },
  };

  await runCli(['run'], {
    actions,
    config: { autoPublish: true },
    write() {},
  });

  assert.deepEqual(calls, ['collect', 'enrich', 'publish']);
});

test('list renders machine-readable JSON without requiring framework state', async () => {
  const output = [];
  const rows = [{ id: 31, status: 'enriched', titleZh: '中文标题' }];

  const result = await runCli(['list', '--json'], {
    actions: {
      async list() {
        return rows;
      },
    },
    config: {},
    write(value) {
      output.push(value);
    },
  });

  assert.deepEqual(result, rows);
  assert.deepEqual(JSON.parse(output.join('')), rows);
});
